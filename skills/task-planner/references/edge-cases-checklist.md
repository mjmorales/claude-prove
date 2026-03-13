# Edge Case Discovery Checklist

Systematic approach to finding edge cases during task planning.

## Universal Edge Cases

Always consider these regardless of task type:

### Input Validation
- [ ] **Null/None/undefined**: How does the code handle missing values?
- [ ] **Empty**: Empty strings, empty arrays, empty objects
- [ ] **Wrong type**: String when expecting number, object when expecting array
- [ ] **Out of range**: Negative numbers, values exceeding limits
- [ ] **Special characters**: Unicode, emojis, control characters
- [ ] **Injection attacks**: SQL injection, XSS, command injection
- [ ] **Malformed data**: Invalid JSON, corrupt files, bad encoding

### Boundary Conditions
- [ ] **Zero**: Division by zero, zero-length operations
- [ ] **One**: Single item in collections, off-by-one errors
- [ ] **Maximum values**: Integer overflow, string length limits
- [ ] **Minimum values**: Underflow, negative indices
- [ ] **Exactly at limit**: Right at quota, exactly max file size
- [ ] **Just over limit**: One byte too large, one item too many

### State and Timing
- [ ] **Race conditions**: Concurrent modifications
- [ ] **Deadlocks**: Circular dependencies
- [ ] **Stale data**: Cache invalidation, eventual consistency
- [ ] **Partial operations**: Process killed mid-operation
- [ ] **Initialization order**: Dependencies not ready
- [ ] **Cleanup failures**: Resources not released

### System Resources
- [ ] **Out of memory**: Memory exhaustion scenarios
- [ ] **Disk full**: No space for writes
- [ ] **Network issues**: Timeouts, connection drops
- [ ] **Permission denied**: Insufficient privileges
- [ ] **Resource locks**: Files in use, database locks
- [ ] **Rate limiting**: API quotas exceeded

## Domain-Specific Edge Cases

### Web Applications

#### Authentication & Sessions
- [ ] Expired tokens
- [ ] Invalid credentials
- [ ] Session timeout during operation
- [ ] Multiple simultaneous logins
- [ ] Password reset edge cases
- [ ] Account lockout scenarios

#### API Endpoints
- [ ] Missing required parameters
- [ ] Extra unexpected parameters
- [ ] Malformed request bodies
- [ ] Content-type mismatches
- [ ] CORS issues
- [ ] Method not allowed
- [ ] Request size limits

#### Browser-Specific
- [ ] Back button behavior
- [ ] Multiple tabs/windows
- [ ] Browser refresh during submission
- [ ] JavaScript disabled
- [ ] Ad blockers/extensions
- [ ] Different browser versions

### Database Operations

#### Data Integrity
- [ ] Duplicate key violations
- [ ] Foreign key constraints
- [ ] Cascade deletes
- [ ] Orphaned records
- [ ] Transaction rollbacks
- [ ] Deadlocks

#### Performance
- [ ] N+1 queries
- [ ] Missing indexes
- [ ] Large result sets
- [ ] Slow queries
- [ ] Connection pool exhaustion
- [ ] Long-running transactions

### File Operations

#### File System
- [ ] File doesn't exist
- [ ] File already exists
- [ ] Directory instead of file
- [ ] Symbolic links
- [ ] Hidden files
- [ ] Read-only files

#### File Content
- [ ] Empty files
- [ ] Huge files (GB+)
- [ ] Binary vs. text
- [ ] Different encodings (UTF-8, ASCII, etc.)
- [ ] Line ending differences (LF vs CRLF)
- [ ] Corrupted files

### Distributed Systems

#### Network
- [ ] Network partitions
- [ ] High latency
- [ ] Packet loss
- [ ] DNS failures
- [ ] SSL/TLS issues
- [ ] Proxy/firewall blocking

#### Services
- [ ] Service unavailable
- [ ] Partial service failure
- [ ] Version mismatches
- [ ] Backward compatibility
- [ ] Circuit breaker triggered
- [ ] Retry storms

### Date/Time Operations

- [ ] Timezone differences
- [ ] Daylight saving transitions
- [ ] Leap years
- [ ] Leap seconds
- [ ] Date formatting issues
- [ ] Invalid dates (Feb 30)
- [ ] Year 2038 problem
- [ ] Historical dates
- [ ] Future dates

### User Input

#### Forms
- [ ] Multiple rapid submissions
- [ ] Browser autofill
- [ ] Copy-paste from Word/Excel
- [ ] Drag-and-drop files
- [ ] Maximum field lengths
- [ ] Required field validation

#### Text Processing
- [ ] Different languages
- [ ] RTL text (Arabic, Hebrew)
- [ ] Mixed encodings
- [ ] Line breaks in unexpected places
- [ ] HTML/markdown in plain text fields
- [ ] Very long text without spaces

## Edge Case Discovery Techniques

### 1. Boundary Value Analysis
For any numeric input or limit:
```
If valid range is 1-100:
- Test: 0, 1, 2, 99, 100, 101
- Test: -1, 0.5, 100.1
- Test: null, undefined, "100"
```

### 2. Equivalence Partitioning
Group inputs into classes:
```
Age verification:
- Invalid: < 0
- Minor: 0-17
- Adult: 18-120
- Invalid: > 120
Test one from each partition
```

### 3. State Transition Testing
Map all state transitions:
```
Order states: Draft → Submitted → Approved → Fulfilled
Test:
- Valid transitions
- Invalid transitions (Draft → Fulfilled)
- Same state transitions
- Concurrent state changes
```

### 4. Error Guessing
Based on experience:
```
Common errors:
- Off-by-one in loops
- Null pointer exceptions
- Integer overflow
- SQL injection
- Race conditions
```

### 5. Chaos Engineering
What if:
- Database goes down mid-transaction?
- API returns 500 randomly?
- Clock jumps forward/backward?
- Disk fills up during write?
- Memory corrupted?

## Edge Case Documentation Template

For each edge case discovered:

```markdown
### Edge Case: [Name]

**Scenario**: [Description of the edge case]

**Current Behavior**: [What happens now]
```python
# Code showing current behavior
```

**Risk Level**: Low | Medium | High | Critical

**Proposed Handling**:
- Option 1: [Approach with trade-offs]
- Option 2: [Alternative approach]

**Recommended**: [Which option and why]

**Test Case**:
```python
def test_edge_case_name():
    # Test implementation
```

**Implementation Notes**:
- [Any special considerations]
```

## Questions to Ask During Planning

### For Every Feature
1. What's the worst input this could receive?
2. What if two users do this simultaneously?
3. What if the operation fails halfway?
4. What if we need to rollback?
5. How does this behave under load?

### For Data Operations
1. What if the data doesn't exist?
2. What if there's more data than expected?
3. What if the data is corrupted?
4. What if we lose connection mid-operation?
5. What about data migrations?

### For External Dependencies
1. What if the service is down?
2. What if it returns unexpected data?
3. What if it's slow?
4. What if credentials expire?
5. What about version changes?

### For User Interactions
1. What if they double-click submit?
2. What if they use the back button?
3. What if they open multiple tabs?
4. What if they lose connection?
5. What if they're using an old browser?

## Red Flags in Code

Look for these patterns that often hide edge cases:

- **Assertions without else**: Assumes success
- **Empty catch blocks**: Swallows errors
- **Hardcoded values**: Magic numbers/strings
- **No timeout handling**: Infinite waits
- **No null checks**: NPE waiting to happen
- **Unbounded loops**: Potential infinite loops
- **No input validation**: Trusts all input
- **Global state**: Race condition prone
- **Recursive without limit**: Stack overflow risk
- **Direct array access**: Index out of bounds

## Edge Case Priority Matrix

| Impact ↓ / Frequency → | Common | Occasional | Rare |
|-------------------------|---------|------------|------|
| **Data Loss**          | P0 Critical | P0 Critical | P1 High |
| **Security Breach**    | P0 Critical | P0 Critical | P1 High |
| **Service Down**       | P0 Critical | P1 High | P2 Medium |
| **Bad UX**             | P1 High | P2 Medium | P3 Low |
| **Performance**        | P1 High | P2 Medium | P3 Low |
| **Cosmetic**           | P2 Medium | P3 Low | P4 Minor |

Use this to prioritize which edge cases to handle in implementation.