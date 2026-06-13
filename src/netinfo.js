import os from 'node:os';

/**
 * Resolve the machine's primary external LAN IPv4 address.
 * Returns the first non-internal IPv4 address found, falling back to `127.0.0.1`
 * when no external interface is available.
 * @param {() => Record<string, os.NetworkInterfaceInfo[] | undefined>} [networkInterfaces]
 *   optional source of network interfaces (injectable for testing); defaults to `os.networkInterfaces`
 * @returns {string} the LAN IPv4 address, or `127.0.0.1` as a fallback
 */
export function getLanIPv4(networkInterfaces = os.networkInterfaces) {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}
