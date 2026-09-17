const assert = require('node:assert/strict');

// Keep the reporting check offline and avoid starting aggregation workers.
require.cache[require.resolve('../src/lib/threads')] = {
	exports: {
		pools: {},
		quickPool: async (_size, _name, run) => run({}),
	},
};
const { sendToHouston } = require('../src/lib/stats');
const errors = [];
const noop = () => {};
const client = {
	guilds: { cache: new Map() },
	log: {
		debug: noop,
		error: (_message, detail) => errors.push(detail),
		info: { cron: noop },
		success: noop,
		verbose: noop,
		warn: noop,
	},
	prisma: {
		guild: { findMany: async () => [] },
		user: {
			aggregate: async () => ({
				_count: 0,
				_sum: { messageCount: 0 },
			}),
		},
	},
	user: { id: 'test' },
};

(async () => {
	global.fetch = async () => {
		throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
	};
	await sendToHouston(client);
	assert.equal(errors.pop(), 'connect ECONNREFUSED');
	global.fetch = async () => new Response('Service unavailable', { status: 503 });
	await sendToHouston(client);
	assert.equal(errors.pop(), 'HTTP 503: Service unavailable');
	global.fetch = async () => new Response('{}');
	await sendToHouston(client);
	assert.equal(errors.length, 0);
})();
