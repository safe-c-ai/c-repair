import { request } from 'node:http';

/** Local inference may take longer than fetch's independent 300s header limit.
 * The bridge owns inference deadlines; the caller's signal still cancels the
 * socket, including while receiving the body. No shared/global fetch overrides.
 */
export function localBridgeRequest(url: string, options: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: options.method,
      headers: options.headers,
      signal: options.signal,
      agent: false,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const headers = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        }
        const status = res.statusCode ?? 500;
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
      });
    });
    req.on('error', reject);
    req.end(options.body);
  });
}
