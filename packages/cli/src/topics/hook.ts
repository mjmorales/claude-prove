import type { CAC } from 'cac';
import { registerStubTopic } from '../stub-topic';

export function register(cli: CAC): void {
  registerStubTopic(cli, {
    name: 'hook',
    description: 'Claude Code hook dispatch (not yet implemented)',
    phase: 3,
  });
}
