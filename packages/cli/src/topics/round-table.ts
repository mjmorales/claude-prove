import type { CAC } from 'cac';
import { registerStubTopic } from '../stub-topic';

export function register(cli: CAC): void {
  registerStubTopic(cli, {
    name: 'round-table',
    description: 'Multi-agent deliberation (not yet implemented)',
    phase: 8,
  });
}
