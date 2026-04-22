import type { CAC } from 'cac';
import { registerStubTopic } from '../stub-topic';

export function register(cli: CAC): void {
  registerStubTopic(cli, {
    name: 'cafi',
    description: 'Content-addressable file index (not yet implemented)',
    phase: 5,
  });
}
