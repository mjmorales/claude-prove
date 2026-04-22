import { StubCommand } from '../../stub-command';

export default class Schema extends StubCommand {
  static override description = 'Prove config schema migrations (not yet implemented)';
  protected readonly phase = 4;
}
