# Edge Case Discovery Checklist

## Universal Edge Cases

### Input Validation
- [ ] **Null/None/undefined**: missing values
- [ ] **Empty**: empty strings, arrays, objects
- [ ] **Wrong type**: string when expecting number, object when expecting array
- [ ] **Out of range**: negative numbers, values exceeding limits
- [ ] **Special characters**: Unicode, emojis, control characters
- [ ] **Injection attacks**: SQL injection, XSS, command injection
- [ ] **Malformed data**: invalid JSON, corrupt files, bad encoding

### Boundary Conditions
- [ ] **Zero**: division by zero, zero-length operations
- [ ] **One**: single item in collections, off-by-one errors
- [ ] **Maximum values**: integer overflow, string length limits
- [ ] **Minimum values**: underflow, negative indices
- [ ] **Exactly at limit**: right at quota, exactly max file size
- [ ] **Just over limit**: one byte too large, one item too many

### State and Timing
- [ ] **Race conditions**: concurrent modifications
- [ ] **Deadlocks**: circular dependencies
- [ ] **Stale data**: cache invalidation, eventual consistency
- [ ] **Partial operations**: process killed mid-operation
- [ ] **Initialization order**: dependencies not ready
- [ ] **Cleanup failures**: resources not released

### System Resources
- [ ] **Out of memory**: memory exhaustion scenarios
- [ ] **Disk full**: no space for writes
- [ ] **Network issues**: timeouts, connection drops
- [ ] **Permission denied**: insufficient privileges
- [ ] **Resource locks**: files in use, database locks
- [ ] **Rate limiting**: API quotas exceeded

## Domain-Specific Edge Cases

### Web Applications

**Authentication & Sessions**: expired tokens, invalid credentials, session timeout during operation, multiple simultaneous logins, password reset edge cases, account lockout

**API Endpoints**: missing required params, extra unexpected params, malformed request bodies, content-type mismatches, CORS issues, method not allowed, request size limits

**Browser-Specific**: back button behavior, multiple tabs/windows, refresh during submission, JavaScript disabled, ad blockers/extensions, different browser versions

### Database Operations

**Data Integrity**: duplicate key violations, foreign key constraints, cascade deletes, orphaned records, transaction rollbacks, deadlocks

**Performance**: N+1 queries, missing indexes, large result sets, slow queries, connection pool exhaustion, long-running transactions

### File Operations

**File System**: file doesn't exist, file already exists, directory instead of file, symbolic links, hidden files, read-only files

**File Content**: empty files, huge files (GB+), binary vs text, different encodings (UTF-8, ASCII), line ending differences (LF vs CRLF), corrupted files

### Distributed Systems

**Network**: network partitions, high latency, packet loss, DNS failures, SSL/TLS issues, proxy/firewall blocking

**Services**: service unavailable, partial failure, version mismatches, backward compatibility, circuit breaker triggered, retry storms

### Date/Time
Timezone differences, daylight saving transitions, leap years/seconds, date formatting issues, invalid dates (Feb 30), year 2038 problem, historical/future dates

### User Input

**Forms**: multiple rapid submissions, browser autofill, copy-paste from Word/Excel, drag-and-drop files, max field lengths, required field validation

**Text Processing**: different languages, RTL text (Arabic, Hebrew), mixed encodings, line breaks in unexpected places, HTML/markdown in plain text fields, very long text without spaces

## Red Flags in Code

Patterns that often hide edge cases:

- **Assertions without else**: assumes success
- **Empty catch blocks**: swallows errors
- **Hardcoded values**: magic numbers/strings
- **No timeout handling**: infinite waits
- **No null checks**: NPE waiting to happen
- **Unbounded loops**: potential infinite loops
- **No input validation**: trusts all input
- **Global state**: race condition prone
- **Recursive without limit**: stack overflow risk
- **Direct array access**: index out of bounds

## Priority Matrix

| Impact / Frequency | Common | Occasional | Rare |
|--------------------|--------|------------|------|
| **Data Loss**      | P0 | P0 | P1 |
| **Security Breach**| P0 | P0 | P1 |
| **Service Down**   | P0 | P1 | P2 |
| **Bad UX**         | P1 | P2 | P3 |
| **Performance**    | P1 | P2 | P3 |
| **Cosmetic**       | P2 | P3 | P4 |
