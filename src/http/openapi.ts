interface OpenApiDocument {
  openapi: '3.0.3';
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: {
    url: string;
  }[];
  tags: {
    name: string;
    description: string;
  }[];
  components: Record<string, unknown>;
  paths: Record<string, unknown>;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, '');
}

export function createOpenApiDocument(origin: string): OpenApiDocument {
  const serverUrl = trimTrailingSlash(origin);

  return {
    openapi: '3.0.3',
    info: {
      title: 'Repo Pulse API',
      version: '1.0.0',
      description:
        'Repo Pulse receives GitHub webhooks, persists accepted deliveries to a D1 ledger, and dispatches notifications to configured providers from Cloudflare Workers.',
    },
    servers: [{ url: serverUrl }],
    tags: [
      {
        name: 'webhook',
        description: 'Public GitHub webhook ingestion endpoint.',
      },
      {
        name: 'admin',
        description: 'Authenticated operational and delivery-ledger endpoints.',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'opaque',
        },
      },
      headers: {
        GitHubEvent: {
          description: 'GitHub webhook event type.',
          schema: { type: 'string', example: 'star' },
        },
        GitHubDelivery: {
          description: 'GitHub unique delivery identifier.',
          schema: { type: 'string', example: '72d3162e-cc78-11e3-81ab-4c9367dc0958' },
        },
        GitHubSignature256: {
          description: 'GitHub HMAC SHA-256 signature.',
          schema: { type: 'string', example: 'sha256=<hex digest>' },
        },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          required: ['success', 'code', 'message'],
          properties: {
            success: { type: 'boolean', enum: [false] },
            code: { type: 'string' },
            message: { type: 'string' },
            details: {},
          },
        },
        WebhookAcceptedResponse: {
          type: 'object',
          required: ['success', 'message', 'eventType', 'repository'],
          properties: {
            success: { type: 'boolean', enum: [true] },
            message: { type: 'string', example: 'Webhook accepted for asynchronous processing' },
            eventType: { type: 'string', example: 'star.created' },
            repository: { type: 'string', example: 'myorg/repo' },
          },
        },
        DuplicateWebhookResponse: {
          type: 'object',
          required: ['success', 'message', 'eventType', 'repository', 'duplicate'],
          properties: {
            success: { type: 'boolean', enum: [true] },
            message: { type: 'string', example: 'Duplicate delivery acknowledged' },
            eventType: { type: 'string', example: 'star.created' },
            repository: { type: 'string', example: 'myorg/repo' },
            duplicate: { type: 'boolean', enum: [true] },
          },
        },
        UnsupportedWebhookResponse: {
          type: 'object',
          required: ['success', 'message', 'eventType', 'repository'],
          properties: {
            success: { type: 'boolean', enum: [true] },
            message: { type: 'string', example: "Event type 'ping' is not supported" },
            eventType: { type: 'string', example: 'ping' },
            repository: { type: 'string', example: 'myorg/repo' },
          },
        },
        DeliveryLedgerStats: {
          type: 'object',
          required: ['total', 'pending', 'processing', 'failed', 'succeeded'],
          properties: {
            total: { type: 'number', example: 42 },
            pending: { type: 'number', example: 2 },
            processing: { type: 'number', example: 1 },
            failed: { type: 'number', example: 3 },
            succeeded: { type: 'number', example: 36 },
          },
        },
        DeliverySummary: {
          type: 'object',
          required: [
            'deliveryId',
            'sourceEventType',
            'eventType',
            'repository',
            'status',
            'acceptedAt',
            'nextAttemptAt',
            'processingStartedAt',
            'processingFinishedAt',
            'processingAttempts',
            'maxAttempts',
            'providerAttemptCount',
            'lastError',
            'lastFailureClassification',
          ],
          properties: {
            deliveryId: { type: 'string', example: 'delivery-123' },
            sourceEventType: { type: 'string', example: 'star' },
            eventType: { type: 'string', example: 'star.created' },
            repository: { type: 'string', example: 'myorg/repo' },
            status: {
              type: 'string',
              enum: ['pending', 'processing', 'succeeded', 'failed'],
            },
            acceptedAt: { type: 'string', format: 'date-time' },
            nextAttemptAt: { type: 'string', format: 'date-time', nullable: true },
            processingStartedAt: { type: 'string', format: 'date-time', nullable: true },
            processingFinishedAt: { type: 'string', format: 'date-time', nullable: true },
            processingAttempts: { type: 'number', example: 1 },
            maxAttempts: { type: 'number', example: 5 },
            providerAttemptCount: { type: 'number', example: 1 },
            lastError: { type: 'string', nullable: true, example: 'discord: Discord unavailable' },
            lastFailureClassification: {
              type: 'string',
              enum: ['transient', 'permanent'],
              nullable: true,
            },
          },
        },
        ProviderAttempt: {
          type: 'object',
          required: ['id', 'deliveryAttempt', 'provider', 'attemptedAt', 'success', 'error'],
          properties: {
            id: { type: 'number', example: 1 },
            deliveryAttempt: { type: 'number', example: 1 },
            provider: { type: 'string', example: 'discord' },
            attemptedAt: { type: 'string', format: 'date-time' },
            success: { type: 'boolean', example: false },
            error: { type: 'string', nullable: true, example: 'Discord returned 500' },
          },
        },
        RepoEventEnvelope: {
          type: 'object',
          required: ['type', 'action', 'repository', 'sender', 'timestamp'],
          properties: {
            type: { type: 'string', example: 'star.created' },
            action: { type: 'string', example: 'created' },
            repository: {
              type: 'object',
              additionalProperties: true,
            },
            sender: {
              type: 'object',
              additionalProperties: true,
            },
            timestamp: { type: 'string', format: 'date-time' },
          },
          additionalProperties: true,
        },
        DeliveryDetails: {
          allOf: [
            { $ref: '#/components/schemas/DeliverySummary' },
            {
              type: 'object',
              required: ['event', 'attempts'],
              properties: {
                event: { $ref: '#/components/schemas/RepoEventEnvelope' },
                attempts: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/ProviderAttempt' },
                },
              },
            },
          ],
        },
        AdminStatusResponse: {
          type: 'object',
          required: ['name', 'version', 'status', 'providers', 'deliveryLedger'],
          properties: {
            name: { type: 'string', example: 'repo-pulse' },
            version: { type: 'string', example: '1.0.0' },
            status: { type: 'string', example: 'running' },
            providers: {
              type: 'array',
              items: { type: 'string' },
              example: ['discord'],
            },
            deliveryLedger: { $ref: '#/components/schemas/DeliveryLedgerStats' },
          },
        },
        AdminHealthResponse: {
          type: 'object',
          required: ['status', 'providers', 'trackedDeliveries'],
          properties: {
            status: { type: 'string', example: 'ok' },
            providers: {
              type: 'array',
              items: { type: 'string' },
              example: ['discord'],
            },
            trackedDeliveries: { type: 'number', example: 42 },
          },
        },
        AdminDeliveryListResponse: {
          type: 'object',
          required: ['deliveries'],
          properties: {
            deliveries: {
              type: 'array',
              items: { $ref: '#/components/schemas/DeliverySummary' },
            },
          },
        },
        AdminRetryDeliveryResponse: {
          type: 'object',
          required: ['success', 'message', 'delivery'],
          properties: {
            success: { type: 'boolean', enum: [true] },
            message: { type: 'string', example: 'Delivery queued for retry' },
            delivery: { $ref: '#/components/schemas/DeliveryDetails' },
          },
        },
      },
    },
    paths: {
      '/webhook': {
        post: {
          tags: ['webhook'],
          summary: 'Receive a GitHub webhook delivery',
          description:
            'Validates the GitHub signature, enforces a bounded request body size, normalizes supported payloads, persists accepted deliveries to D1, and drains notifier work through Workers waitUntil plus scheduled follow-up.',
          parameters: [
            {
              name: 'X-GitHub-Event',
              in: 'header',
              required: true,
              schema: { $ref: '#/components/headers/GitHubEvent/schema' },
            },
            {
              name: 'X-GitHub-Delivery',
              in: 'header',
              required: true,
              schema: { $ref: '#/components/headers/GitHubDelivery/schema' },
            },
            {
              name: 'X-Hub-Signature-256',
              in: 'header',
              required: true,
              schema: { $ref: '#/components/headers/GitHubSignature256/schema' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: true,
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Duplicate or unsupported delivery acknowledged.',
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      { $ref: '#/components/schemas/DuplicateWebhookResponse' },
                      { $ref: '#/components/schemas/UnsupportedWebhookResponse' },
                    ],
                  },
                },
              },
            },
            '202': {
              description: 'Supported delivery accepted and persisted for asynchronous processing.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/WebhookAcceptedResponse' },
                },
              },
            },
            '400': {
              description: 'Malformed request or invalid supported payload.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '413': {
              description: 'Request body exceeds the configured webhook size limit.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '401': {
              description: 'Invalid GitHub signature.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '500': {
              description: 'No notification providers are configured.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/admin/status': {
        get: {
          tags: ['admin'],
          summary: 'Get service status',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Current service status.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AdminStatusResponse' },
                },
              },
            },
            '401': {
              description: 'Missing or invalid admin bearer token.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/admin/health': {
        get: {
          tags: ['admin'],
          summary: 'Get operational health details',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Current operational health details.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AdminHealthResponse' },
                },
              },
            },
            '401': {
              description: 'Missing or invalid admin bearer token.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/admin/deliveries': {
        get: {
          tags: ['admin'],
          summary: 'List persisted deliveries',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'status',
              in: 'query',
              required: false,
              description:
                "Comma-separated delivery statuses. Supported values: 'pending', 'processing', 'succeeded', 'failed'.",
              schema: {
                type: 'string',
                example: 'failed,pending',
              },
            },
          ],
          responses: {
            '200': {
              description: 'Persisted deliveries matching the filter.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AdminDeliveryListResponse' },
                },
              },
            },
            '400': {
              description: 'Invalid delivery filter.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '401': {
              description: 'Missing or invalid admin bearer token.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/admin/deliveries/{deliveryId}': {
        get: {
          tags: ['admin'],
          summary: 'Get one delivery with attempt history',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'deliveryId',
              in: 'path',
              required: true,
              schema: { type: 'string', example: 'delivery-123' },
            },
          ],
          responses: {
            '200': {
              description: 'Delivery details.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/DeliveryDetails' },
                },
              },
            },
            '401': {
              description: 'Missing or invalid admin bearer token.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '404': {
              description: 'Delivery not found.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/admin/deliveries/{deliveryId}/retry': {
        post: {
          tags: ['admin'],
          summary: 'Retry a failed delivery',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'deliveryId',
              in: 'path',
              required: true,
              schema: { type: 'string', example: 'delivery-123' },
            },
          ],
          responses: {
            '202': {
              description: 'Delivery re-queued for processing.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AdminRetryDeliveryResponse' },
                },
              },
            },
            '401': {
              description: 'Missing or invalid admin bearer token.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '404': {
              description: 'Delivery not found.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '409': {
              description: 'Delivery is not in a retryable state.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/admin/openapi.json': {
        get: {
          tags: ['admin'],
          summary: 'Get the OpenAPI document',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'OpenAPI document.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    additionalProperties: true,
                  },
                },
              },
            },
            '401': {
              description: 'Missing or invalid admin bearer token.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/admin/docs': {
        get: {
          tags: ['admin'],
          summary: 'Open the Swagger UI',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Swagger UI HTML.',
              content: {
                'text/html': {
                  schema: { type: 'string' },
                },
              },
            },
            '401': {
              description: 'Missing or invalid admin bearer token.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
    },
  };
}

export function renderSwaggerUiPage(document: OpenApiDocument): string {
  const serializedDocument = JSON.stringify(document).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Repo Pulse API Docs</title>
    <link
      rel="stylesheet"
      href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css"
    />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        background: #101418;
      }

      #swagger-ui {
        min-height: 100vh;
      }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
    <script>
      const openApiDocument = ${serializedDocument};
      window.addEventListener('load', function () {
        window.SwaggerUIBundle({
          spec: openApiDocument,
          dom_id: '#swagger-ui',
          deepLinking: true,
          persistAuthorization: true,
        });
      });
    </script>
  </body>
</html>`;
}
