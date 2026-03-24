# LLM-Optimized Coding Standards

Code patterns that maximize LLM comprehension, completion accuracy, and agent effectiveness. Apply across all projects and languages.

## 1. Naming as Prior Activation

Names are the highest-leverage signal. Names matching training data distributions activate stronger priors and produce better completions.

- **Use canonical names**: `UserRepository` over `DataAccessObject`. `err` in Go, `req`/`res` in Express, `e` in Python except blocks -- these are loaded tokens with strong priors.
- **Domain-specific signatures**: `calculateShippingCost(order: Order, region: Region)` vastly outperforms `process(input: any, config: object)`.
- **Scoped verbosity**: verbose names at module scope (`orderPayload`, `authResponse`), short names in tight loops. Matches training distribution.
- **File names prime the model**: `user_repository.go` activates repository-pattern priors. `utils.go` activates nothing useful.
- **Avoid generics at module scope**: `data`, `result`, `obj`, `item` are low-information tokens. The model cannot attach semantics to them.

## 2. Structure for Local Context

LLMs reason best when intent fits within local attention. Structure code so each unit is self-contained.

- **Short functions** (10-30 lines): the model holds the entire function's intent in local context. 300-line functions cause mid-function context loss.
- **Consistent function length**: if all service methods are 10-30 lines, the model calibrates to that budget. Variable lengths cause variable output quality.
- **Flat over deep**: 2 levels of nesting is fine. 5+ levels means the model spends capacity tracking indentation instead of understanding intent.
- **One concept per file**: the model orients to a file as a unit. Multiple unrelated concerns in one file cause blended outputs.
- **Named pipeline steps**: `validateInput -> enrichData -> persistRecord -> emitEvent` gives the model semantic checkpoints even if each function is called once.
- **Consistent abstraction level per function**: mixing high-level domain ops with low-level byte manipulation in one function body causes register-shifting in completions.

## 3. Explicitness Over Cleverness

Explicit code reduces inference load and increases modification accuracy.

- **Explicit types always**: even in dynamic languages, type annotations and JSDoc drastically improve accuracy. The model sees data shape without inferring from usage.
- **Types and interfaces at file top**: mirrors tutorial/library structure. The model orients faster.
- **Named fields over positional args**: `{ sendWelcomeEmail: true }` over `createUser(data, true)`. Boolean params are opaque.
- **Constructor injection over service locators**: `new OrderService(db, mailer, logger)` -- every dependency visible. DI containers are opaque to the model.
- **Intermediate named variables**: `const filtered = items.filter(...)` then `const sorted = filtered.sort(...)` gives the model grip points. Long method chains are hard to modify correctly.
- **Avoid clever one-liners**: the model can read compressed chains but editing them reliably is harder. Prefer explicit multi-step code for anything the model will modify.
- **Enums/constants over magic values**: `Status.PENDING` carries semantics. `"pending"` is weaker. `2` tells the model nothing.

## 4. Idiomatic Patterns and Consistency

The model has orders-of-magnitude more training signal for idiomatic code. Deviation from idioms is expensive.

- **Write idiomatic code for your language**: Go idioms in Go, Pythonic Python, idiomatic TS. Java-style OOP in Go confuses the model -- that pattern is rare in Go training data.
- **Match popular OSS style**: code that looks like Django source, Express middleware, or stdlib patterns gets near-perfect completions.
- **Idiomatic error handling**: Go's `if err != nil`, Python's try/except, Rust's `?` -- the model handles these fluently. Custom error monads require learning local convention.
- **One async paradigm**: mixing callbacks, promises, and async/await in one codebase causes inconsistent generation. Pick one.
- **Standard conventions always**: HTTP status codes, log levels, SQL patterns -- use the established norm. The model has strong expectations for these.
- **Consistency compounds**: if all handlers/services/repos follow the same shape, the model learns your local idiom fast. Every variation forces fresh reasoning.
- **Consistency of approach over individual choice**: whether exceptions or result types, whether errors bubble or handle locally -- pick one, never deviate. Inconsistency forces per-case reasoning.

## 5. Context as Prompt Engineering

How you structure context directly affects generation quality.

- **One concrete example beats prose**: LLMs mirror. Show one instance of the pattern at the top of a file and it replicates. More reliable than describing what you want.
- **Framework anchoring**: if the first function looks like Express middleware, everything after will follow that groove.
- **Recency bias in context**: the model follows the last strong example it saw. 10 correct handlers + 1 weird one most recent = the weird one gets replicated. Order matters.
- **Signatures as prompts**: an empty function body with a typed signature constrains the solution space enormously. Often sufficient for correct implementation.
- **Tests as context**: test files showing inputs and expected outputs are often more useful than the implementation itself for guiding changes.
- **Contracts in separate files**: `interfaces.ts`, `types.go`, `schema.py` -- isolating contracts means the model can understand system shape without reading implementations.

## 6. Comments and Documentation as Semantic Signal

Comments that add information the model cannot infer from code are high value. Comments restating mechanics are noise.

- **Intent over mechanics**: `// retry up to 3 times on transient network errors` is useful. `// call the function again` is noise.
- **Alias custom abstractions**: `// EventBus implements the standard Observer pattern` gives the model a training-data hook.
- **Document invariants inline**: `// len(items) is always > 0 here, checked by caller` prevents incorrect modifications. The model cannot infer this.
- **Explain unusual decisions**: a comment at the top of a file explaining an unconventional architectural choice anchors the model to work within your constraint instead of fighting toward convention.
- **TODO as agent seams**: `// TODO: handle the case where user is deactivated` functions as a structured prompt embedded in code. Agents act on these directly.
- **Structured log statements**: `log.Info("processing order", "orderId", id, "userId", userId)` is semantic signal the model reads and infers intent from. `log.Info("here")` is waste.

## 7. Codebase Hygiene

Dead signals actively degrade generation quality.

- **Remove dead code and commented-out blocks**: the model treats them as valid signal and may blend current and deprecated approaches.
- **Clean imports**: unused imports/variables cause the model to account for them. Clean imports signal a maintained codebase and improve generation quality.
- **No shadowing or aliasing**: reusing variable names in inner scopes or aliasing types causes the model to conflate them. Common source of subtle generation bugs.
- **Happy path first, edge cases after**: matches training distribution from tutorials. Defensive-code-first structure causes the model to overweight defensive branches.

## 8. Agent-Specific Patterns

When writing code for Claude Code or similar agents that see the codebase in slices:

- **Local legibility over global elegance**: every file and function must tell a coherent story in isolation.
- **Docstrings and type annotations pay double**: they help the model understand code AND are the first thing an agent reads when deciding how to call something.
- **Self-contained tests**: repetition is fine. Each test with inline setup. DRY tests are bad for human debugging and worse for LLM reasoning.
- **Domain-oriented package structure**: `orders/`, `payments/`, `users/` gives domain context immediately. `models/`, `services/`, `controllers/` requires more reading before the model knows the domain.
- **Small interfaces**: 3-method interface = single-pass reasoning. 20-method interface = method confusion and hallucinated methods.
- **State machines with named states/transitions**: maps well to how the model reasons about control flow. High training density from game dev and UI code.
- **Explicit constraints when fighting priors**: the model weights toward the most common valid implementation. Say "prefer Y over Z" when the default prior is not what you want.
