import assert from 'node:assert/strict';
import { manifest } from '@discord-tickets/settings/build/server/manifest.js';
import { handler } from '@discord-tickets/settings/build/handler.js';

assert.equal(typeof handler, 'function');
for (const id of ['/(default)/[guild]/tickets', '/(default)/transcripts/[guild]/[ticket]']) {
	const route = manifest._.routes.find(route => route.id === id);
	assert.ok(route?.page, `Missing portal page: ${id}`);
	const page = await manifest._.nodes[route.page.leaf]();
	assert.equal(typeof page.universal.load, 'function');
	await page.component();
}
