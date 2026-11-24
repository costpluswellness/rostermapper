// The public demo's lookups: the UI asks app/api/nppes, app/api/census and app/api/nppes-name, as it
// asks the CLI's local server (NPPES and the Census geocoder have no CORS). Answers are public data,
// so the CDN keeps them for a day and asks the source again only after that.
import { answerLookup, useDiskCache } from '../../../src/validate/lookup.ts';

useDiskCache(false);

export default async (req: Request): Promise<Response> => {
	const url = new URL(req.url);
	const { status, body } = await answerLookup(url.pathname, url.searchParams);
	return Response.json(body, {
		status,
		headers: status === 200 ? { 'cache-control': 'public, max-age=3600', 'netlify-cdn-cache-control': 'public, durable, max-age=86400' } : {},
	});
};

export const config = { path: ['/app/api/nppes', '/app/api/census', '/app/api/nppes-name'] };
