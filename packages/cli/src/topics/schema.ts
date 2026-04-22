import type { CAC } from 'cac';
import { registerStubTopic } from '../stub-topic';

export function register(cli: CAC): void {
  registerStubTopic(cli, {
    name: 'schema',
    description: 'Prove config schema migrations (not yet implemented)',
    phase: 4,
  });
}
