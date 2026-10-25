import { Agent } from 'undici';
// Some component endpoints advertise unreachable IPv6 routes. TLS checks stay enabled.
const dispatcher = new Agent({ connect: { family: 4 }, connections: 8 });
let transport: typeof fetch | undefined;
export function setLoaderTransport(fetcher: typeof fetch): void {
  transport = fetcher;
}
export const fetchIPv4: typeof fetch = (input, init) =>
  globalThis.fetch(input, { ...init, dispatcher } as RequestInit);
export const fetchLoader: typeof fetch = (input, init) =>
  transport ? transport(input, init) : fetchIPv4(input, init);
