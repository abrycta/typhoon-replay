// Redocly plugin enforcing the contract's portable subset of OpenAPI 3.1 and its naming rules
// (CONTRACT-GUIDE §1). Every rule exists because at least one of the four generators
// (oapi-codegen strict, openapi-generator spring, typify, openapi-typescript/fastify-openapi-glue) mishandles the construct,
// or because the rule keeps the four backends interchangeable.

const BANNED_KEYWORDS = [
  '$dynamicRef', '$dynamicAnchor', 'if', 'then', 'else', 'patternProperties', 'unevaluatedProperties',
  'unevaluatedItems', 'prefixItems', 'dependentSchemas', 'dependentRequired', 'contains', 'not', 'anyOf', 'const',
  'nullable',
];
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CAMEL = /^[a-z][a-zA-Z0-9]*$/;
const OPERATION_ID = /^(get|list|search|create|stream)[A-Z][A-Za-z0-9]*$/;
const REQUIRED_HEADERS = ['X-Backend-Impl', 'X-Backend-Version', 'X-Contract-Version', 'X-Request-Id', 'Cache-Control'];
const NO_BODY_STATUSES = new Set(['204', '304']);
const SAFE_METHODS = new Set(['get', 'head']);

function isSchemaContext(ctx) {
  // Skip `properties` maps etc.: the Schema visitor only fires on schema objects.
  return ctx.type && ctx.type.name === 'Schema';
}

const NoTypeArrays = () => ({
  Schema(schema, ctx) {
    if (Array.isArray(schema.type)) {
      ctx.report({ message: 'Type arrays are not portable: use a single `type` and omit the field instead of null.', location: ctx.location.child('type') });
    }
  },
});

const NoNull = () => ({
  Schema(schema, ctx) {
    if (!isSchemaContext(ctx)) return;
    if (schema.type === 'null') {
      ctx.report({ message: 'Optional fields are omitted, never null: `type: null` is not allowed.', location: ctx.location.child('type') });
    }
    if (Array.isArray(schema.enum) && schema.enum.includes(null)) {
      ctx.report({ message: '`null` is not allowed in enums.', location: ctx.location.child('enum') });
    }
  },
});

const BannedKeywords = () => ({
  Schema(schema, ctx) {
    for (const k of BANNED_KEYWORDS) {
      if (Object.prototype.hasOwnProperty.call(schema, k)) {
        const hint = k === 'const' ? ' Use a one-value `enum`.' : k === 'anyOf' ? ' Use `oneOf` with a discriminator.' : '';
        ctx.report({ message: `\`${k}\` is outside the portable subset.${hint}`, location: ctx.location.child(k).key() });
      }
    }
  },
});

const OneOfNeedsDiscriminator = () => ({
  Schema(schema, ctx) {
    if (schema.oneOf && !(schema.discriminator && schema.discriminator.propertyName && schema.discriminator.mapping)) {
      ctx.report({ message: '`oneOf` is only allowed with a `discriminator` that has a `propertyName` and an explicit `mapping`.', location: ctx.location.child('oneOf').key() });
    }
  },
});

const NoWebhooks = () => ({
  Root(root, ctx) {
    if (root.webhooks) ctx.report({ message: '`webhooks` are not used by this contract.', location: ctx.location.child('webhooks').key() });
  },
});

const NoClosedObjects = () => ({
  Schema(schema, ctx) {
    if (schema.additionalProperties === false) {
      ctx.report({
        message: '`additionalProperties: false` breaks the tolerant-reader rule (typify would deny unknown fields). Leave objects open.',
        location: ctx.location.child('additionalProperties'),
      });
    }
  },
});

const ArrayMaxItems = () => ({
  Schema(schema, ctx) {
    if (schema.type === 'array' && typeof schema.maxItems !== 'number') {
      ctx.report({ message: 'Every array needs `maxItems`, so responses stay inside the 64 KB cap.', location: ctx.location.child('type') });
    }
  },
});

const PropertyCamelCase = () => ({
  Schema(schema, ctx) {
    if (!schema.properties) return;
    for (const name of Object.keys(schema.properties)) {
      if (!CAMEL.test(name)) {
        ctx.report({ message: `Property \`${name}\` must be camelCase.`, location: ctx.location.child(['properties', name]).key() });
      }
    }
  },
});

const EnumKebabCase = () => ({
  Schema(schema, ctx) {
    if (!Array.isArray(schema.enum) || schema['x-external-enum'] === true) return;
    for (const v of schema.enum) {
      if (typeof v === 'string' && !KEBAB.test(v)) {
        ctx.report({
          message: `Enum value \`${v}\` must be kebab-case (or mark the schema \`x-external-enum: true\` for an external code list such as ISO 3166 or GeoJSON types).`,
          location: ctx.location.child('enum'),
        });
      }
    }
  },
});

const PathSegmentCase = () => ({
  PathItem: {
    enter(_item, ctx) {
      const path = ctx.key;
      if (typeof path !== 'string') return;
      for (const seg of path.split('/').slice(1)) {
        const ok = /^\{[a-z][A-Za-z0-9]*\}$/.test(seg) || KEBAB.test(seg) || seg === '_test' || seg === 'openapi.json';
        if (!ok) ctx.report({ message: `Path segment \`${seg}\` must be kebab-case (or a camelCase {param}).`, location: ctx.location.key() });
      }
    },
  },
});

const OperationIdVerbNoun = () => ({
  Operation(op, ctx) {
    if (op.operationId && !OPERATION_ID.test(op.operationId)) {
      ctx.report({ message: `operationId \`${op.operationId}\` must be verbNoun, starting with a known verb (get, list, search, create, stream).`, location: ctx.location.child('operationId') });
    }
  },
});

function statusOf(ctx) {
  const key = String(ctx.key);
  return /^[1-5]\d\d$/.test(key) ? key : undefined; // skip components.responses entries; they are checked where used
}

const SuccessHasExample = () => ({
  Response(response, ctx) {
    const status = statusOf(ctx);
    if (!status || !/^2/.test(status) || NO_BODY_STATUSES.has(status)) return;
    for (const [mediaType, media] of Object.entries(response.content || {})) {
      if (media.example === undefined && !media.examples) {
        ctx.report({ message: `${status} ${mediaType} needs an \`example\` or \`examples\`.`, location: ctx.location.child(['content', mediaType]).key() });
      }
    }
  },
});

const ErrorsAreProblemJson = () => ({
  Response(response, ctx) {
    const status = statusOf(ctx);
    if (!status || !/^[45]/.test(status)) return;
    const types = Object.keys(response.content || {});
    if (types.length !== 1 || types[0] !== 'application/problem+json') {
      ctx.report({ message: `${status} must have exactly one media type, application/problem+json.`, location: ctx.location.key() });
    }
  },
});

const RequiredResponseHeaders = () => ({
  Response(response, ctx) {
    const status = statusOf(ctx);
    if (!status) return;
    const headers = response.headers || {};
    for (const h of REQUIRED_HEADERS) {
      const header = headers[h] ? ctx.resolve(headers[h]).node : undefined;
      if (!header || header.required !== true) {
        ctx.report({ message: `${status} response must declare required header \`${h}\` (CONTRACT-GUIDE §4).`, location: ctx.location.key() });
      }
    }
  },
});

const SseEventsDeclared = () => ({
  Operation(op, ctx) {
    const usesSse = Object.values(op.responses || {}).some((ref) => {
      const response = ctx.resolve(ref).node || {};
      return Object.keys(response.content || {}).includes('text/event-stream');
    });
    if (!usesSse) return;
    const events = op['x-sse-events'];
    if (!events || typeof events !== 'object' || Object.keys(events).length === 0) {
      ctx.report({ message: 'text/event-stream operations must map every `event:` name to a data schema in `x-sse-events`.', location: ctx.location.key() });
      return;
    }
    for (const [name, value] of Object.entries(events)) {
      if (!KEBAB.test(name)) ctx.report({ message: `SSE event name \`${name}\` must be kebab-case.`, location: ctx.location.child(['x-sse-events', name]).key() });
      if (!value || typeof value.$ref !== 'string') ctx.report({ message: `x-sse-events.${name} must be a $ref to a component schema.`, location: ctx.location.child(['x-sse-events', name]) });
    }
  },
});

// Contract 2.0.0 (CONTRACT-GUIDE §14): no accounts. Every public operation is an anonymous GET: no security schemes,
// no operation-level security, no cookies in or out. Unsafe methods exist only on x-internal test hooks.
const PublicReadOnly = () => ({
  Root: {
    enter(root, ctx) {
      if (root.components?.securitySchemes) ctx.report({ message: 'No security schemes: every operation is public (CONTRACT-GUIDE §14).', location: ctx.location.child(['components', 'securitySchemes']).key() });
      if (!Array.isArray(root.security) || root.security.length !== 0) ctx.report({ message: 'Root `security` must be `[]` (all operations public).', location: ctx.location.child('security') });
    },
  },
  PathItem(item, ctx) {
    for (const [method, op] of Object.entries(item)) {
      if (!op || typeof op !== 'object' || !op.responses) continue;
      if (op.security && op.security.length) ctx.report({ message: `${method.toUpperCase()} must not require security (CONTRACT-GUIDE §14).`, location: ctx.location.child([method, 'security']) });
      if (!SAFE_METHODS.has(method) && op['x-internal'] !== true) ctx.report({ message: `${method.toUpperCase()} is not allowed on public operations: the API is read-only (only x-internal test hooks may write).`, location: ctx.location.child(method).key() });
    }
  },
  Parameter(param, ctx) {
    if (param.in === 'cookie') ctx.report({ message: 'Cookie parameters are not allowed: the API has no sessions.', location: ctx.location.child('in') });
  },
  Response(response, ctx) {
    for (const name of Object.keys(response.headers || {})) {
      if (name.toLowerCase() === 'set-cookie') ctx.report({ message: 'Responses must not set cookies.', location: ctx.location.child(['headers', name]).key() });
    }
  },
});

export default function portableSubsetPlugin() {
  return {
    id: 'portable',
    rules: {
      oas3: {
        'no-type-arrays': NoTypeArrays,
        'no-null': NoNull,
        'banned-keywords': BannedKeywords,
        'oneof-needs-discriminator': OneOfNeedsDiscriminator,
        'no-webhooks': NoWebhooks,
        'no-closed-objects': NoClosedObjects,
        'array-max-items': ArrayMaxItems,
        'property-camel-case': PropertyCamelCase,
        'enum-kebab-case': EnumKebabCase,
        'path-segment-case': PathSegmentCase,
        'operation-id-verb-noun': OperationIdVerbNoun,
        'success-has-example': SuccessHasExample,
        'errors-are-problem-json': ErrorsAreProblemJson,
        'required-response-headers': RequiredResponseHeaders,
        'sse-events-declared': SseEventsDeclared,
        'public-read-only': PublicReadOnly,
      },
    },
  };
}
