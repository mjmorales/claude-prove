import type { CAC } from 'cac';
import { registerStubTopic } from '../stub-topic';

export function register(cli: CAC): void {
  registerStubTopic(cli, {
    name: 'pcd',
    description: 'Structural-map audits (not yet implemented)',
    phase: 7,
  });
}
