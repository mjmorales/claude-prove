# Planning Patterns Reference

## Risk Assessment Matrix

| Impact / Likelihood | Low | Medium | High |
|---------------------|-----|--------|------|
| **High**            | Medium | High | Critical |
| **Medium**          | Low | Medium | High |
| **Low**             | Minimal | Low | Medium |

## Requirement Gathering

### Five Whys
Ask "why" repeatedly to find root requirements:
1. "We need a user dashboard" -- Why? To see system status -- Why? To identify issues -- Why? To minimize downtime -- Why? SLA compliance (root requirement).

### MoSCoW Prioritization
- **Must**: core functionality, project fails without it
- **Should**: important, not vital for initial release
- **Could**: nice to have if time permits
- **Won't**: explicitly out of scope this iteration

## Design Decision Frameworks

### ADR Format
```markdown
## Title: [Short name]
### Status: [Proposed | Accepted | Deprecated]
### Context: [Issue motivating this decision]
### Decision: [Change proposed/made]
### Consequences: [What becomes easier/harder]
```

### Trade-off Axes
1. **Performance** -- speed, resource usage
2. **Complexity** -- implementation difficulty, maintenance burden
3. **Flexibility** -- extensibility, future changes
4. **Cost** -- development time, licensing, operations
5. **Risk** -- technical debt, vendor lock-in

## Edge Case Techniques

### Boundary Analysis
For any input/constraint: lower bound, upper bound, just below lower, just above upper, empty/null, type mismatch.

### State Transition Mapping
1. List all possible states
2. Map valid transitions
3. Identify invalid transitions
4. Consider concurrent state changes
5. Plan error state recovery

## Integration Planning

### Contract-First Design
1. Define interface contract explicitly
2. Create mock implementations
3. Document assumptions
4. Plan for contract changes
5. Define fallback behavior

## Test Planning

### Test Pyramid
Few slow UI tests > some integration tests > many fast unit tests.

### Given-When-Then
- **Given**: initial context/state
- **When**: action performed
- **Then**: expected outcome

## Complexity Estimation

| Size | Points | Time | Description |
|------|--------|------|-------------|
| XS | 1 | < 2h | trivial change |
| S | 2 | 2-4h | simple feature |
| M | 5 | 1-2d | moderate complexity |
| L | 8 | 3-5d | complex feature |
| XL | 13 | 1-2w | very complex |
| XXL | 20+ | > 2w | needs decomposition |

**Uncertainty multipliers**: 1.5x (some unknowns), 2x (significant unknowns), 3x (new tech/domain), 4x (research required).

## Anti-Patterns

**Planning**: analysis paralysis, big design up front, assumption-driven design, gold plating, scope creep.

**Implementation planning**: underestimating integration complexity, ignoring error handling until end, happy-path-only planning, no rollback scenarios, forgetting monitoring/observability.

## Resolution Strategies

**Conflicting requirements**: identify conflict explicitly, understand priorities, propose compromise, document trade-offs, get sign-off.

**Technical uncertainty**: identify unknowns, create proof-of-concept, time-box investigation, document findings, adjust plan.

**Scope issues**: list all features, map to original requirements, core vs nice-to-have, propose phased delivery, get agreement.
