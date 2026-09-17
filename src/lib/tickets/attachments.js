const {
	createReadStream, createWriteStream,
} = require('node:fs');
const fs = require('node:fs/promises');
const {
	join, dirname,
} = require('node:path');
const {
	randomBytes, pbkdf2, createCipheriv, createDecipheriv,
} = require('node:crypto');
const { promisify } = require('node:util');
const {
	Readable, Transform,
} = require('node:stream');
const { pipeline } = require('node:stream/promises');

const deriveKey = promisify(pbkdf2);
const pending = new Map();
const maxBytes = 512 * 1024 * 1024;

function attachmentPath(guild, ticket, message, attachment) {
	const ids = [guild, ticket, message, attachment];
	if (!ids.every(id => /^\d{16,20}$/.test(id))) throw new Error('Invalid attachment identifier');
	return join(process.cwd(), 'user', 'attachments', ...ids.slice(0, -1), `${attachment}.bin`);
}

async function saveAttachment(guild, ticket, message, attachment) {
	const path = attachmentPath(guild, ticket, message, attachment.id);
	if (pending.has(path)) return pending.get(path);
	const task = (async () => {
		try {
			await fs.access(path);
			return;
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
		const url = new URL(attachment.url);
		if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) ||
			url.port || !new RegExp(`^/attachments/\\d{16,20}/${attachment.id}/`).test(url.pathname)) {
			throw new Error('Invalid Discord attachment URL');
		}
		const response = await fetch(url, {
			redirect: 'error',
			signal: AbortSignal.timeout(60000),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Attachment download failed (${response.status})`);
		}
		if (Number(response.headers.get('content-length')) > maxBytes) {
			await response.body.cancel();
			throw new Error('Attachment exceeds 512 MiB');
		}
		await fs.mkdir(dirname(path), {
			mode: 0o700,
			recursive: true,
		});
		const temporary = `${path}.${randomBytes(8).toString('hex')}.part`;
		// Cryptr's salt/IV/tag layout, streamed as binary to avoid buffering large files.
		const salt = randomBytes(64);
		const iv = randomBytes(16);
		const key = await deriveKey(process.env.ENCRYPTION_KEY, salt, 100000, 32, 'sha512');
		const cipher = createCipheriv('aes-256-gcm', key, iv);
		let size = 0;
		try {
			await fs.writeFile(temporary, Buffer.concat([salt, iv, Buffer.alloc(16)]), {
				flag: 'wx',
				mode: 0o600,
			});
			await pipeline(Readable.fromWeb(response.body), new Transform({
				transform(chunk, encoding, callback) {
					size += chunk.length;
					callback(size > maxBytes ? new Error('Attachment exceeds 512 MiB') : null, chunk);
				},
			}), cipher, createWriteStream(temporary, {
				flags: 'r+',
				start: 96,
			}));
			const file = await fs.open(temporary, 'r+');
			try {
				await file.write(cipher.getAuthTag(), 0, 16, 80);
			} finally {
				await file.close();
			}
			await fs.rename(temporary, path);
		} finally {
			await fs.rm(temporary, { force: true });
		}
	})();
	pending.set(path, task);
	try {
		return await task;
	} finally {
		pending.delete(path);
	}
}

async function readAttachment(guild, ticket, message, attachment) {
	const path = attachmentPath(guild, ticket, message, attachment);
	if (pending.has(path)) await pending.get(path);
	const file = await fs.open(path, 'r');
	const header = Buffer.alloc(96);
	try {
		const { bytesRead } = await file.read(header, 0, 96, 0);
		if (bytesRead !== 96) throw new Error('Invalid archived attachment');
	} finally {
		await file.close();
	}
	const key = await deriveKey(process.env.ENCRYPTION_KEY, header.subarray(0, 64), 100000, 32, 'sha512');
	const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(64, 80));
	decipher.setAuthTag(header.subarray(80, 96));
	pipeline(createReadStream(path, { start: 96 }), decipher).catch(error => decipher.destroy(error));
	return decipher;
}

module.exports = {
	readAttachment,
	saveAttachment,
};
