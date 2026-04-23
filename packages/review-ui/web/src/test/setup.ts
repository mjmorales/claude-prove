/**
 * DOM test setup. Import this at the top of any *.test.tsx before importing
 * @testing-library/react. Idempotent.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: "http://localhost/" });
}
