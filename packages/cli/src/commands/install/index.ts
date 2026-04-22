import { StubCommand } from '../../stub-command';

export default class Install extends StubCommand {
  static override description = 'Install Claude-side wiring (not yet implemented)';
  protected readonly phase = 10;
}
