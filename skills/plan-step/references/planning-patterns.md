# Planning Patterns Reference

## Advanced Planning Techniques

### Risk Assessment Matrix

When evaluating potential issues, use this matrix to prioritize:

| Impact ↓ / Likelihood → | Low | Medium | High |
|--------------------------|-----|---------|------|
| **High**                 | Medium Risk | High Risk | Critical |
| **Medium**               | Low Risk | Medium Risk | High Risk |
| **Low**                  | Minimal | Low Risk | Medium Risk |

### Requirement Gathering Patterns

#### The Five Whys
When a requirement seems vague, ask "why" repeatedly:
1. "We need a user dashboard" → Why?
2. "To see system status" → Why?
3. "To identify issues quickly" → Why?
4. "To minimize downtime" → Why?
5. "To maintain SLA compliance" → Root requirement identified

#### MoSCoW Prioritization
Categorize requirements as:
- **Must have**: Core functionality, project fails without it
- **Should have**: Important but not vital for initial release
- **Could have**: Nice to have if time permits
- **Won't have**: Explicitly out of scope for this iteration

### Design Decision Frameworks

#### ADR (Architecture Decision Record) Format
```markdown
## Title: [Short name]

### Status
[Proposed | Accepted | Deprecated]

### Context
[What is the issue that we're seeing that is motivating this decision?]

### Decision
[What is the change that we're proposing/doing?]

### Consequences
[What becomes easier or more difficult because of this change?]
```

#### Trade-off Analysis Template
When comparing options:
1. **Performance** - Speed, resource usage
2. **Complexity** - Implementation difficulty, maintenance burden
3. **Flexibility** - Extensibility, future changes
4. **Cost** - Development time, licensing, operations
5. **Risk** - Technical debt, vendor lock-in

### Edge Case Discovery Techniques

#### Boundary Analysis
For any input or constraint:
- **Lower bound**: Minimum valid value
- **Upper bound**: Maximum valid value
- **Just below lower**: Invalid case
- **Just above upper**: Invalid case
- **Empty/null**: Missing input
- **Type mismatch**: Wrong data type

#### State Transition Mapping
For stateful components:
1. List all possible states
2. Map valid transitions between states
3. Identify invalid transitions
4. Consider concurrent state changes
5. Plan for state recovery after errors

### Integration Planning Patterns

#### Contract-First Design
When depending on external systems:
1. Define the interface contract explicitly
2. Create mock implementations
3. Document assumptions
4. Plan for contract changes
5. Define fallback behavior

#### Dependency Injection Planning
Structure dependencies to be:
- Explicit (not hidden)
- Mockable (for testing)
- Configurable (for different environments)
- Versioned (for compatibility)

### Test Planning Strategies

#### Test Pyramid
Balance test types:
```
         /\
        /  \  UI Tests (few, slow, brittle)
       /    \
      /------\  Integration Tests (some, moderate)
     /        \
    /----------\  Unit Tests (many, fast, stable)
```

#### Given-When-Then Format
Structure test scenarios:
- **Given**: Initial context/state
- **When**: Action performed
- **Then**: Expected outcome
- **And**: Additional conditions

### Complexity Estimation Techniques

#### T-Shirt Sizing with Points
- **XS** (1 point): < 2 hours, trivial change
- **S** (2 points): 2-4 hours, simple feature
- **M** (5 points): 1-2 days, moderate complexity
- **L** (8 points): 3-5 days, complex feature
- **XL** (13 points): 1-2 weeks, very complex
- **XXL** (20+ points): > 2 weeks, needs breaking down

#### Uncertainty Factors
Multiply estimates by:
- **1.5x**: Some unknowns
- **2x**: Significant unknowns
- **3x**: New technology/domain
- **4x**: Research required

### Communication Patterns

#### Stakeholder Mapping
Identify for each stakeholder:
- Interest level (High/Medium/Low)
- Influence level (High/Medium/Low)
- Communication needs
- Decision authority

#### Documentation Levels
1. **Code comments**: Why, not what
2. **README**: How to use
3. **Design docs**: Why built this way
4. **User docs**: How to accomplish tasks
5. **API docs**: Contract and examples

### Common Anti-Patterns to Avoid

#### Planning Anti-Patterns
- **Analysis Paralysis**: Over-planning without progress
- **Big Design Up Front**: Trying to predict everything
- **Assumption-Driven Design**: Not validating with users
- **Gold Plating**: Adding unnecessary features
- **Scope Creep**: Gradual requirement expansion

#### Implementation Planning Pitfalls
- Underestimating integration complexity
- Ignoring error handling until the end
- Planning for happy path only
- Not considering rollback scenarios
- Forgetting about monitoring/observability

### Resolution Strategies

#### For Conflicting Requirements
1. Identify the conflict explicitly
2. Understand stakeholder priorities
3. Propose compromise solutions
4. Document trade-offs
5. Get explicit sign-off

#### For Technical Uncertainty
1. Identify specific unknowns
2. Create proof-of-concept
3. Time-box investigation
4. Document findings
5. Adjust plan based on results

#### For Scope Issues
1. List all requested features
2. Map to original requirements
3. Identify core vs. nice-to-have
4. Propose phased delivery
5. Get stakeholder agreement