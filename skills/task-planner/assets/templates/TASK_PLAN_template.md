# .prove/TASK_PLAN.md Template

This template shows the standard format for task plans generated during discovery.

---

```markdown
# Task Plan: [Task Name]

**Type**: Bug Fix | Feature | Refactor | Performance | Security
**Priority**: P0 Critical | P1 High | P2 Medium | P3 Low
**Estimated Effort**: XS (1-2hr) | S (2-4hr) | M (1-2d) | L (3-5d) | XL (1-2w)
**Risk Level**: Low | Medium | High
**Created**: [Date]

## Executive Summary
[1-2 sentences describing what we're doing and why it matters]

## Background
[Context from our discovery phase - why this is needed, what problem it solves]

## Current State
Based on code exploration:
- [How the system currently works]
- [Key files/components involved]
- [Current limitations or issues]

## Desired State
After implementation:
- [How the system should work]
- [Improvements delivered]
- [Success criteria]

## Technical Approach
[High-level strategy based on our research and analysis]

## Dependencies & Prerequisites
- [ ] [External dependency or requirement]
- [ ] [Another prerequisite]
- [ ] [Knowledge/access needed]

## Implementation Steps

### Task 1.1: [Setup/Preparation]
**Size**: XS
**Risk**: Low
**Description**: [What we're doing and why]

**Changes**:
- `path/to/file.py`:
  - [ ] Add import for [library]
  - [ ] Create configuration for [feature]
  
**Verification**:
- [ ] Configuration loads without errors
- [ ] Existing tests still pass
- [ ] New config appears in logs

**Tests to Write**:
```python
def test_configuration_loads():
    # Verify configuration is valid
    pass
```

**Commands to Run**:
```bash
# Verify setup
python -m module.config --validate
```

---

### Task 1.2: [Core Implementation Part 1]
**Size**: M
**Risk**: Medium
**Description**: [Main functionality being added]
**Dependencies**: Task 1.1 must be complete

**Changes**:
- `src/core/feature.py`:
  - [ ] Create new class `FeatureHandler`
  - [ ] Implement `process()` method
  - [ ] Add error handling for [edge case]
  
- `src/utils/helper.py`:
  - [ ] Add helper function `validate_input()`
  - [ ] Update existing `format_output()` to handle new format

**Code Skeleton**:
```python
class FeatureHandler:
    def __init__(self, config):
        self.config = config
        
    def process(self, data):
        # Validate input
        # Process data
        # Handle errors
        # Return result
        pass
```

**Verification**:
- [ ] Unit tests pass for new class
- [ ] Integration with existing code works
- [ ] Error cases handled gracefully

**Tests to Write**:
```python
def test_feature_handler_process():
    # Test happy path
    pass

def test_feature_handler_error_cases():
    # Test edge cases discovered
    pass
```

---

### Task 1.3: [Edge Case Handling]
**Size**: S
**Risk**: Low
**Description**: Handle edge cases discovered during exploration
**Dependencies**: Task 1.2

**Edge Cases to Address**:
1. **Null input**: Currently crashes → Should return default
2. **Concurrent access**: Race condition → Add locking
3. **Large data**: Memory issue → Implement streaming

**Changes**:
- `src/core/feature.py`:
  - [ ] Add null check in `process()`
  - [ ] Implement thread lock for shared resources
  - [ ] Add streaming for large datasets

**Verification**:
- [ ] Null input returns gracefully
- [ ] Concurrent test passes
- [ ] Large file processing doesn't OOM

---

### Task 2.1: [Integration]
**Size**: M
**Risk**: Medium
**Description**: Connect new feature to existing system
**Dependencies**: Tasks 1.2-1.3

**Changes**:
- `src/api/endpoints.py`:
  - [ ] Add new endpoint `/feature`
  - [ ] Wire up to FeatureHandler
  - [ ] Add request validation

- `src/middleware/auth.py`:
  - [ ] Add permission check for new feature

**Verification**:
- [ ] Endpoint responds to requests
- [ ] Authentication works
- [ ] Existing endpoints unaffected

---

### Task 2.2: [Performance Optimization]
**Size**: S
**Risk**: Low
**Description**: Optimize based on profiling results
**Dependencies**: Task 2.1

**Optimizations**:
- [ ] Add caching for repeated calls
- [ ] Optimize database query
- [ ] Add index on frequently queried field

**Verification**:
- [ ] Response time < 100ms for typical request
- [ ] Cache hit rate > 80%
- [ ] Database query uses index

---

### Task 3.1: [Documentation & Cleanup]
**Size**: XS
**Risk**: Low
**Description**: Document changes and clean up code
**Dependencies**: All previous tasks

**Tasks**:
- [ ] Write API documentation
- [ ] Update README with new feature
- [ ] Add inline code comments
- [ ] Remove debug logging
- [ ] Update CHANGELOG

**Verification**:
- [ ] Documentation builds without errors
- [ ] No TODO/FIXME comments remain
- [ ] Code passes linting

## Edge Cases Handled

Based on our discovery:

| Edge Case | Current Behavior | New Behavior | Test Coverage |
|-----------|------------------|--------------|---------------|
| Null input | Crashes with NPE | Returns default value | `test_null_input()` |
| Empty array | Returns error | Returns empty result | `test_empty_array()` |
| Concurrent access | Race condition | Thread-safe with lock | `test_concurrent()` |
| Network timeout | Hangs forever | Times out after 30s | `test_timeout()` |
| Invalid format | Silently fails | Logs error, returns None | `test_invalid_format()` |

## Rollback Plan

If issues arise after deployment:

1. **Immediate**: Feature flag to disable new endpoint
2. **Quick**: Revert PR [to be created]
3. **Database**: No schema changes, no rollback needed
4. **Cache**: Clear cache with `redis-cli FLUSHDB`

## Monitoring & Alerts

Post-deployment monitoring:

- **Metrics to Track**:
  - Request rate on new endpoint
  - Error rate (target < 1%)
  - P95 latency (target < 100ms)
  - Memory usage

- **Alerts to Set**:
  - Error rate > 5%
  - Latency P95 > 200ms
  - Memory usage > 80%

- **Logs to Check**:
  ```bash
  grep "FeatureHandler" /var/log/app.log
  grep ERROR /var/log/app.log | grep feature
  ```

## Success Criteria

This task is complete when:
- [ ] All implementation steps verified
- [ ] All edge cases have test coverage
- [ ] Performance meets targets
- [ ] Documentation updated
- [ ] Code reviewed and approved
- [ ] Deployed to staging and tested
- [ ] Monitoring confirms stability

## Notes from Discovery

- **Git History**: Previous attempt in PR #123 was reverted due to [issue]
- **Technical Debt**: Consider refactoring `OldFeature` class in future
- **Future Enhancement**: Could add [feature] in next iteration
- **Assumption**: We're assuming [condition] remains true

## References

- Original issue: [#456]
- Related PRs: [#123, #789]
- Design doc: [link]
- API spec: [link]
```

---

## Usage with plan-step Skill

This .prove/TASK_PLAN.md integrates with the plan-step skill:

1. Each task becomes a planning item in plan-step
2. The plan-step skill creates detailed requirements for each task
3. Verification criteria enable testing
4. Dependencies ensure correct order

Example workflow:
```
1. Use task-planner to create .prove/TASK_PLAN.md
2. "Let's work on Task 1.2 from the task plan"
3. plan-step creates .prove/plans/plan_task_1.2/ with detailed requirements
4. Implement task by task with verification
```

## Key Principles

- **Incremental**: Each step is independently valuable
- **Verifiable**: Clear criteria for completion
- **Reversible**: Can rollback if needed
- **Testable**: Tests defined before implementation
- **Safe**: Risk assessed and mitigated