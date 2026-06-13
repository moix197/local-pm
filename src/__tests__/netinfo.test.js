import test from 'node:test';
import assert from 'node:assert/strict';
import { getLanIPv4 } from '../netinfo.js';

test('getLanIPv4: falls back to 127.0.0.1 when no external interface', () => {
  const onlyLoopback = () => ({
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  });
  assert.equal(getLanIPv4(onlyLoopback), '127.0.0.1');
});

test('getLanIPv4: returns 127.0.0.1 when there are no interfaces at all', () => {
  assert.equal(
    getLanIPv4(() => ({})),
    '127.0.0.1',
  );
});

test('getLanIPv4: selects external LAN IPv4 over loopback', () => {
  const withLan = () => ({
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    eth0: [{ family: 'IPv4', address: '192.168.1.42', internal: false }],
  });
  assert.equal(getLanIPv4(withLan), '192.168.1.42');
});

test('getLanIPv4: ignores IPv6 and picks the IPv4 external address', () => {
  const mixed = () => ({
    eth0: [
      { family: 'IPv6', address: 'fe80::1', internal: false },
      { family: 'IPv4', address: '10.0.0.5', internal: false },
    ],
  });
  assert.equal(getLanIPv4(mixed), '10.0.0.5');
});
