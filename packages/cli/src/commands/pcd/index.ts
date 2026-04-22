import { StubCommand } from '../../stub-command';

export default class Pcd extends StubCommand {
  static override description = 'Structural-map audits (not yet implemented)';
  protected readonly phase = 7;
}
