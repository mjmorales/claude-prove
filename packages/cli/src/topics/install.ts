import type { CAC } from 'cac';
import { registerStubTopic } from '../stub-topic';

export function register(cli: CAC): void {
  registerStubTopic(cli, {
    name: 'install',
    description: 'Install Claude-side wiring (not yet implemented)',
    phase: 10,
  });
}
