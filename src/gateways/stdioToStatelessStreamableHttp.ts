import express from 'express'
import cors, { type CorsOptions } from 'cors'
import { spawn } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  JSONRPCMessage,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'

export interface StdioToStreamableHttpArgs {
  stdioCmd: string
  port: number
  streamableHttpPath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  headers: Record<string, string>
  protocolVersion: string
}

const setResponseHeaders = ({
  res,
  headers,
}: {
  res: express.Response
  headers: Record<string, string>
}) =>
  Object.entries(headers).forEach(([key, value]) => {
    res.setHeader(key, value)
  })

// Helper function to create initialize request
const createInitializeRequest = (
  id: string | number,
  protocolVersion: string,
): JSONRPCMessage => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion,
    capabilities: {
      roots: {
        listChanged: true,
      },
      sampling: {},
    },
    clientInfo: {
      name: 'supergateway',
      version: getVersion(),
    },
  },
})

// Helper function to create initialized notification
const createInitializedNotification = (): JSONRPCMessage => ({
  jsonrpc: '2.0',
  method: 'notifications/initialized',
})

export async function stdioToStatelessStreamableHttp(
  args: StdioToStreamableHttpArgs,
) {
  const {
    stdioCmd,
    port,
    streamableHttpPath,
    logger,
    corsOrigin,
    healthEndpoints,
    headers,
    protocolVersion,
  } = args

  logger.info(
    `  - Headers: ${Object(headers).length ? JSON.stringify(headers) : '(none)'}`,
  )
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  logger.info(`  - streamableHttpPath: ${streamableHttpPath}`)
  logger.info(`  - protocolVersion: ${protocolVersion}`)

  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )

  onSignals({ logger })

  // Prevent transport.send() errors from crashing the process.
  // These can occur when the SDK's internal connection map is cleaned up
  // after a response is sent but before our transportClosed flag is set.
  process.on('uncaughtException', (err) => {
    logger.error('[stateless] Uncaught exception (server kept alive):', err)
  })
  process.on('unhandledRejection', (reason) => {
    logger.error('[stateless] Unhandled rejection (server kept alive):', reason)
  })

  const app = express()
  app.use(express.json())

  if (corsOrigin) {
    app.use(cors({ origin: corsOrigin }))
  }

  for (const ep of healthEndpoints) {
    app.get(ep, (req, res) => {
      logger.info(`Health check: GET ${req.path} → 200`)
      setResponseHeaders({
        res,
        headers,
      })
      res.send('ok')
    })
  }

  app.post(streamableHttpPath, async (req, res) => {
    // In stateless mode, create a new instance of transport and server for each request
    // to ensure complete isolation. A single instance would cause request ID collisions
    // when multiple clients connect concurrently.
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`

    const body = req.body
    const method = body?.method ?? '(unknown)'
    const id = body?.id ?? '(none)'
    logger.info(`[${requestId}] New request: method=${method} id=${id}`)

    // Log headers that are relevant for debugging protocol/session issues
    const relevantHeaders = [
      'content-type',
      'accept',
      'mcp-session-id',
      'mcp-protocol-version',
      'authorization',
    ]
    const incomingHeaders = relevantHeaders
      .filter((h) => req.headers[h] !== undefined)
      .map((h) =>
        h === 'authorization' ? `${h}: [redacted]` : `${h}: ${req.headers[h]}`,
      )
    if (incomingHeaders.length > 0) {
      logger.info(`[${requestId}] Headers: ${incomingHeaders.join(', ')}`)
    }

    // Intercept res.writeHead to log the response status
    const originalWriteHead = res.writeHead.bind(res)
    ;(res as any).writeHead = (statusCode: number, ...args: any[]) => {
      logger.info(`[${requestId}] Response: status=${statusCode}`)
      return originalWriteHead(statusCode, ...args)
    }

    // Handle ping directly without spawning a child process. The ping method
    // is a standard JSON-RPC keepalive that requires no MCP server involvement.
    // Spawning a child for ping causes a ~1s delay and a race condition when
    // the SDK cleans up the connection map before the child finishes starting.
    if (body?.method === 'ping' && body?.id !== undefined) {
      logger.info(`[${requestId}] Handling ping directly (id=${body.id})`)
      try {
        const pingServer = new Server(
          { name: 'supergateway', version: getVersion() },
          { capabilities: {} },
        )
        const pingTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        })
        await pingServer.connect(pingTransport)
        await pingTransport.handleRequest(req, res, req.body)
      } catch (pingErr) {
        logger.error(`[${requestId}] Ping handler error:`, pingErr)
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: body.id,
          })
        }
      }
      return
    }

    try {
      const server = new Server(
        { name: 'supergateway', version: getVersion() },
        { capabilities: {} },
      )
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })

      await server.connect(transport)
      const child = spawn(stdioCmd, { shell: true })
      logger.info(`[${requestId}] Spawned child pid=${child.pid}`)
      child.on('exit', (code, signal) => {
        logger.error(
          `[${requestId}] Child pid=${child.pid} exited: code=${code}, signal=${signal}`,
        )
        transport.close()
      })

      // State tracking for initialization flow
      let isInitialized = false
      let initializeRequestId: string | number | null = null // Current initialize request ID
      let isAutoInitializing = false // Flag to indicate if we're auto-initializing
      let pendingOriginalMessage: JSONRPCMessage | null = null

      // Buffer messages that arrive from the child before handleRequest has
      // finished registering the HTTP connection internally. Without this,
      // fast-responding MCP servers can trigger transport.send() before the
      // transport's internal request map is populated, causing:
      //   "No connection established for request ID: <n>"
      let handleRequestDone = false
      let transportClosed = false
      const preHandleQueue: JSONRPCMessage[] = []

      const sendToTransport = (jsonMsg: JSONRPCMessage) => {
        if (transportClosed) {
          logger.info(
            `[${requestId}] [buffer] Dropping message, transport already closed: ${JSON.stringify(jsonMsg)}`,
          )
          return
        }
        if (!handleRequestDone) {
          logger.info(
            `[${requestId}] [buffer] Queuing message (handleRequest not yet done): ${JSON.stringify(jsonMsg)}`,
          )
          preHandleQueue.push(jsonMsg)
        } else {
          try {
            transport.send(jsonMsg)
          } catch (e) {
            logger.error(
              `[${requestId}] [buffer] sendToTransport failed, dropping message: ${JSON.stringify(jsonMsg)}`,
              e,
            )
          }
        }
      }

      let buffer = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        lines.forEach((line) => {
          if (!line.trim()) return
          try {
            const jsonMsg = JSON.parse(line)
            logger.info(`[${requestId}] Child → StreamableHttp:`, line)

            // Handle initialize response (both auto and client initiated)
            if (initializeRequestId && jsonMsg.id === initializeRequestId) {
              logger.info(`[${requestId}] Initialize response received`)
              isInitialized = true

              // If this was our auto-initialization, send initialized notification and pending message
              if (isAutoInitializing) {
                // Send initialized notification
                const initializedNotification = createInitializedNotification()
                logger.info(
                  `[${requestId}] StreamableHttp → Child (initialized): ${JSON.stringify(initializedNotification)}`,
                )
                child.stdin.write(
                  JSON.stringify(initializedNotification) + '\n',
                )

                // Now send the original message
                if (pendingOriginalMessage) {
                  logger.info(
                    `[${requestId}] StreamableHttp → Child (original): ${JSON.stringify(pendingOriginalMessage)}`,
                  )
                  child.stdin.write(
                    JSON.stringify(pendingOriginalMessage) + '\n',
                  )
                  pendingOriginalMessage = null
                }

                // Reset auto-initialize tracking
                isAutoInitializing = false
                initializeRequestId = null

                // Don't forward our auto-initialize response to the client
                return
              } else {
                // Client-initiated initialize response, just reset tracking
                initializeRequestId = null
              }
            }

            sendToTransport(jsonMsg)
          } catch {
            logger.error(`[${requestId}] Child non-JSON: ${line}`)
          }
        })
      })

      child.stderr.on('data', (chunk: Buffer) => {
        logger.error(`[${requestId}] Child stderr: ${chunk.toString('utf8')}`)
      })

      transport.onmessage = (msg: JSONRPCMessage) => {
        logger.info(
          `[${requestId}] StreamableHttp → Child: ${JSON.stringify(msg)}`,
        )

        // Check if we need to auto-initialize first
        if (!isInitialized && !isInitializeRequest(msg)) {
          // Store the original message and send initialize first
          pendingOriginalMessage = msg
          initializeRequestId = `init_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
          isAutoInitializing = true

          logger.info(
            `[${requestId}] Non-initialize message detected, sending auto-initialize request first`,
          )
          const initRequest = createInitializeRequest(
            initializeRequestId,
            protocolVersion,
          )
          logger.info(
            `[${requestId}] StreamableHttp → Child (auto-initialize): ${JSON.stringify(initRequest)}`,
          )
          child.stdin.write(JSON.stringify(initRequest) + '\n')

          // Don't send the original message yet - it will be sent after initialization
          return
        }

        // Track initialize request ID (both client and auto)
        if (isInitializeRequest(msg) && 'id' in msg && msg.id !== undefined) {
          initializeRequestId = msg.id
          isAutoInitializing = false // This is client-initiated
          logger.info(
            `[${requestId}] Tracking initialize request ID: ${msg.id}`,
          )
        }

        // Send all messages to child process normally
        child.stdin.write(JSON.stringify(msg) + '\n')
      }

      transport.onclose = () => {
        logger.info(
          `[${requestId}] [buffer] StreamableHttp connection closed, killing child pid=${child.pid}`,
        )
        transportClosed = true
        child.kill()
      }

      transport.onerror = (err) => {
        logger.error(`[${requestId}] StreamableHttp error:`, err)
        transportClosed = true
        child.kill()
      }

      await transport.handleRequest(req, res, req.body)
      logger.info(`[${requestId}] handleRequest complete`)

      // Mark as ready and flush any messages that arrived during handleRequest
      handleRequestDone = true
      if (preHandleQueue.length > 0) {
        logger.info(
          `[${requestId}] [buffer] handleRequest done, flushing ${preHandleQueue.length} queued message(s)`,
        )
        for (const msg of preHandleQueue) {
          if (transportClosed) {
            logger.info(
              `[${requestId}] [buffer] Transport closed during flush, dropping remaining queued messages`,
            )
            break
          }
          logger.info(
            `[${requestId}] [buffer] Flushing queued message: ${JSON.stringify(msg)}`,
          )
          try {
            transport.send(msg)
          } catch (e) {
            logger.error(
              `[${requestId}] [buffer] Failed to send queued message to StreamableHttp`,
              e,
            )
          }
        }
      } else {
        logger.info(
          `[${requestId}] [buffer] handleRequest done, no messages were queued (race condition did not occur)`,
        )
      }
    } catch (error) {
      logger.error(`[${requestId}] Error handling MCP request:`, error)
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        })
      }
    }
  })

  app.get(streamableHttpPath, async (req, res) => {
    logger.info('Received GET MCP request')
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed.',
        },
        id: null,
      }),
    )
  })

  app.delete(streamableHttpPath, async (req, res) => {
    logger.info('Received DELETE MCP request')
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed.',
        },
        id: null,
      }),
    )
  })

  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(
      `StreamableHttp endpoint: http://localhost:${port}${streamableHttpPath}`,
    )
  })
}
