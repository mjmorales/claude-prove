# LLM-Optimized Coding Standards

Code patterns that maximize LLM comprehension, completion accuracy, and agent effectiveness.

## 1. Naming as Prior Activation

- **Canonical names**: `UserRepository` over `DataAccessObject`. `err` in Go, `req`/`res` in Express, `e` in Python except -- loaded tokens with strong priors.
- **Domain-specific signatures**: `calculateShippingCost(order: Order, region: Region)` over `process(input: any, config: object)`.
- **Scoped verbosity**: verbose at module scope (`orderPayload`), short in tight loops.
- **File names prime the model**: `user_repository.go` activates repository-pattern priors. `utils.go` activates nothing.
- **No generics at module scope**: `data`, `result`, `obj`, `item` carry no semantics.

## 2. Structure for Local Context

- **Short functions (10-30 lines)**: full intent fits in local attention. 300-line functions cause mid-function context loss.
- **Consistent function length**: uniform 10-30 line methods let the model calibrate. Variable lengths degrade output quality.
- **Flat over deep**: 2 nesting levels fine. 5+ wastes capacity tracking indentation.
- **One concept per file**: multiple concerns cause blended outputs.
- **Named pipeline steps**: `validateInput -> enrichData -> persistRecord -> emitEvent` provides semantic checkpoints.
- **Consistent abstraction level**: mixing domain ops with byte manipulation causes register-shifting.

## 3. Explicitness Over Cleverness

- **Explicit types always**: type annotations and JSDoc let the model see data shape without inference.
- **Types/interfaces at file top**: mirrors tutorial structure, faster orientation.
- **Named fields over positional args**: `{ sendWelcomeEmail: true }` over `createUser(data, true)`.
- **Constructor injection over service locators**: `new OrderService(db, mailer, logger)` makes dependencies visible.
- **Intermediate named variables**: `const filtered = items.filter(...)` then `const sorted = filtered.sort(...)` -- grip points for modification.
- **No clever one-liners**: prefer explicit multi-step code for anything the model will modify.
- **Enums/constants over magic values**: `Status.PENDING` carries semantics. `2` tells the model nothing.

## 4. Idiomatic Patterns and Consistency

- **Write idiomatic code**: Go idioms in Go, Pythonic Python, idiomatic TS. Cross-language patterns (Java OOP in Go) confuse the model.
- **Match popular OSS style**: Django, Express middleware, stdlib patterns get near-perfect completions.
- **Idiomatic error handling**: Go's `if err != nil`, Python's try/except, Rust's `?`. Custom error monads require learning local convention.
- **One async paradigm**: mixing callbacks, promises, and async/await causes inconsistent generation.
- **Standard conventions**: HTTP status codes, log levels, SQL patterns -- use established norms.
- **Consistency compounds**: uniform handler/service/repo shapes let the model learn local idiom fast. Every variation forces fresh reasoning.
- **Pick one approach, never deviate**: exceptions vs result types, bubble vs handle locally -- inconsistency forces per-case reasoning.

## 5. Context as Prompt Engineering

- **One example beats prose**: show one pattern instance at file top and the model replicates it.
- **Framework anchoring**: first function sets the groove for everything after.
- **Recency bias**: the model follows the last strong example. 10 correct handlers + 1 weird recent one = weird gets replicated.
- **Signatures as prompts**: typed signature with empty body constrains the solution space. Often sufficient for correct implementation.
- **Tests as context**: inputs + expected outputs are often more useful than implementation for guiding changes.
- **Contracts in separate files**: `interfaces.ts`, `types.go`, `schema.py` -- system shape without implementations.

## 6. Comments as Semantic Signal

- **Intent over mechanics**: `// retry up to 3 times on transient network errors` -- useful. `// call the function again` -- noise.
- **Alias custom abstractions**: `// EventBus implements the standard Observer pattern` hooks into training data.
- **Document invariants inline**: `// len(items) is always > 0 here, checked by caller` prevents incorrect modifications.
- **Explain unusual decisions**: unconventional architecture comment anchors the model to your constraint instead of fighting toward convention.
- **TODO as agent seams**: `// TODO: handle deactivated user` functions as a structured prompt agents act on.
- **Structured log statements**: `log.Info("processing order", "orderId", id, "userId", userId)` -- semantic signal. `log.Info("here")` -- waste.

## 7. Codebase Hygiene

- **Remove dead code**: the model treats commented-out blocks as valid signal, blending current and deprecated approaches.
- **Clean imports**: unused imports cause the model to account for them.
- **No shadowing or aliasing**: reusing names in inner scopes causes conflation -- common source of subtle generation bugs.
- **Happy path first, edge cases after**: matches training distribution. Defensive-code-first causes overweighted defensive branches.

## 8. Agent-Specific Patterns

- **Local legibility over global elegance**: every file must tell a coherent story in isolation.
- **Docstrings + type annotations pay double**: comprehension aid AND agent discovery signal.
- **Self-contained tests**: inline setup per test. DRY tests hurt human debugging and LLM reasoning.
- **Domain-oriented packages**: `orders/`, `payments/`, `users/` over `models/`, `services/`, `controllers/`.
- **Small interfaces**: 3 methods = single-pass reasoning. 20 methods = confusion and hallucinated methods.
- **Named state machines**: named states/transitions map well to how models reason about control flow.
- **Explicit constraints when fighting priors**: say "prefer Y over Z" when the default prior is wrong.
