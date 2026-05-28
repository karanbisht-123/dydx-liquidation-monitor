import * as Joi from 'joi';

export const configurationSchema = Joi.object({
  DATABASE_URL: Joi.string().required(),
  REDIS_URL: Joi.string().required(),
  FIREBASE_SERVICE_ACCOUNT_JSON: Joi.string().optional(),
  FIREBASE_PROJECT_ID: Joi.string().when('FIREBASE_SERVICE_ACCOUNT_JSON', {
    is: Joi.exist(),
    then: Joi.optional(),
    otherwise: Joi.required(),
  }),
  FIREBASE_CLIENT_EMAIL: Joi.string().when('FIREBASE_SERVICE_ACCOUNT_JSON', {
    is: Joi.exist(),
    then: Joi.optional(),
    otherwise: Joi.required(),
  }),
  FIREBASE_PRIVATE_KEY: Joi.string().when('FIREBASE_SERVICE_ACCOUNT_JSON', {
    is: Joi.exist(),
    then: Joi.optional(),
    otherwise: Joi.required(),
  }),
  DYDX_INDEXER_BASE_URL: Joi.string().default('https://indexer.dydx.trade'),
  DYDX_MARKETS_CACHE_TTL_MS: Joi.number().default(300000),
  MONITOR_INTERVAL_SECONDS: Joi.number().default(30),
  BULL_CONCURRENCY: Joi.number().default(10),
  NODE_ENV: Joi.string().valid('development', 'production', 'test', 'staging').default('development'),
});

export default () => {
  const { error, value } = configurationSchema.validate(process.env, { allowUnknown: true });
  if (error) {
    throw new Error(`Configuration validation error: ${error.message}`);
  }

  let projectId = value.FIREBASE_PROJECT_ID;
  let clientEmail = value.FIREBASE_CLIENT_EMAIL;
  let privateKey = value.FIREBASE_PRIVATE_KEY;

  if (value.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const parsed = JSON.parse(value.FIREBASE_SERVICE_ACCOUNT_JSON);
      projectId = parsed.project_id || projectId;
      clientEmail = parsed.client_email || clientEmail;
      privateKey = parsed.private_key || privateKey;
    } catch (err: any) {
      throw new Error(`Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON: ${err.message}`);
    }
  }

  return {
    databaseUrl: value.DATABASE_URL,
    redisUrl: value.REDIS_URL,
    firebase: {
      projectId,
      clientEmail,
      privateKey,
    },
    dydx: {
      indexerBaseUrl: value.DYDX_INDEXER_BASE_URL,
      marketsCacheTtlMs: value.DYDX_MARKETS_CACHE_TTL_MS,
    },
    monitor: {
      intervalSeconds: value.MONITOR_INTERVAL_SECONDS,
      bullConcurrency: value.BULL_CONCURRENCY,
    },
    nodeEnv: value.NODE_ENV,
  };
};

