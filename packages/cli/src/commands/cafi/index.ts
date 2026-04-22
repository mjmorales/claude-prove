import { StubCommand } from '../../stub-command';

export default class Cafi extends StubCommand {
  static override description = 'Content-addressable file index (not yet implemented)';
  protected readonly phase = 5;
}
