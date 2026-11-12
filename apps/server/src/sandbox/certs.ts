import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';

/**
 * Root certificates this machine trusts beyond the public ones: what a VPN or company network
 * that inspects HTTPS installs (Cloudflare WARP, Zscaler, a company proxy), plus whatever the OS
 * vendor adds (Windows carries some of Microsoft's own). The sandbox image gets them, so its
 * HTTPS works on such networks too. Certificates hold only public keys: copying them reveals
 * nothing secret.
 */
export interface HostCertificate {
  /** SHA-256 fingerprint, as Node formats it (AB:CD:…). */
  fingerprint: string;
  /** Its name (CN, else O). */
  name: string;
  issuer: string;
  validTo: string;
  pem: string;
}

export interface CertificateSources {
  /** The OS's trusted roots (Windows certificate store, macOS keychain, Linux /etc/ssl). */
  system: () => string[];
  /** NODE_EXTRA_CA_CERTS, if the user set it (e.g. for Claude Code). */
  extra: () => string[];
  /** The public roots Node ships (Mozilla's list): the image has the same ones already. */
  bundled: () => string[];
}

const nodeSources: CertificateSources = {
  system: () => tls.getCACertificates('system'),
  extra: () => tls.getCACertificates('extra'),
  bundled: () => tls.getCACertificates('bundled'),
};

const nameOf = (dn: string) => /(?:^|\n)CN=([^\n]+)/.exec(dn)?.[1] ?? /(?:^|\n)O=([^\n]+)/.exec(dn)?.[1] ?? dn.split('\n')[0];

/**
 * The certificates to offer: valid (not expired, already started) certificate authorities this
 * machine trusts that aren't in the public list, by fingerprint, sorted by name. Expired ones and
 * leftovers that aren't CAs (Windows keeps old test and signing certificates) are left out.
 */
export function hostCertificates(sources: CertificateSources = nodeSources, now = Date.now()): HostCertificate[] {
  const read = (get: () => string[]) => {
    try {
      return get();
    } catch {
      return [];
    }
  };
  const parse = (pem: string) => {
    try {
      return new X509Certificate(pem);
    } catch {
      return null;
    }
  };
  const bundled = new Set(read(sources.bundled).flatMap((pem) => parse(pem)?.fingerprint256 ?? []));
  const found = new Map<string, HostCertificate>();
  for (const pem of [...read(sources.system), ...read(sources.extra)]) {
    const cert = parse(pem);
    if (!cert || !cert.ca || bundled.has(cert.fingerprint256) || found.has(cert.fingerprint256)) continue;
    if (Date.parse(cert.validTo) <= now || Date.parse(cert.validFrom) > now) continue;
    found.set(cert.fingerprint256, {
      fingerprint: cert.fingerprint256,
      name: nameOf(cert.subject),
      issuer: nameOf(cert.issuer),
      validTo: new Date(cert.validTo).toISOString(),
      pem: cert.toString().trim(),
    });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.fingerprint.localeCompare(b.fingerprint));
}

/** Proxy variables Harness passes on to image builds and sandboxes when they are set. */
export const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy'];

/** The proxy variables set in `env`. */
export function proxyVariables(env: NodeJS.ProcessEnv): string[] {
  return PROXY_VARIABLES.filter((name) => env[name]);
}
