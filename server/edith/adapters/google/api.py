"""Running Google API requests: retries with backoff, and batching N requests into one round trip."""
import random
import time

RETRIES = 3        # attempts after the first, for 429, 5xx and connection errors
BATCH_SIZE = 50    # Gmail advises at most 50 requests per batch
RETRYABLE = {429, 500, 502, 503, 504}


def execute(request):
    """One request; the client library retries 429/5xx/connection errors with exponential backoff."""
    return request.execute(num_retries=RETRIES)


def _retryable(exc):
    status = getattr(getattr(exc, "resp", None), "status", None)
    return isinstance(exc, OSError) or (status is not None and int(status) in RETRYABLE)


def batch(service, requests, sleep=None):
    """Run `requests` as batches of BATCH_SIZE (one HTTP round trip each) and return the responses
    in the same order. Items that fail with a retryable error are re-sent with backoff; any other
    error is raised."""
    sleep = sleep or time.sleep
    results = [None] * len(requests)
    todo, attempt = list(range(len(requests))), 0
    while todo:
        failed, errors = [], {}

        def done(request_id, response, exception):
            i = int(request_id)
            if exception is None:
                results[i] = response
            else:
                errors[i] = exception

        for start in range(0, len(todo), BATCH_SIZE):
            part = todo[start:start + BATCH_SIZE]
            b = service.new_batch_http_request(callback=done)
            for i in part:
                b.add(requests[i], request_id=str(i))
            try:
                b.execute()
            except Exception as e:
                if not _retryable(e):
                    raise
                errors.update({i: e for i in part if i not in errors and results[i] is None})
        for i, e in sorted(errors.items()):
            if not _retryable(e):
                raise e
            failed.append(i)
        if failed:
            attempt += 1
            if attempt > RETRIES:
                raise errors[failed[0]]
            sleep(min(30.0, 2 ** attempt) * (0.5 + random.random() / 2))  # backoff with jitter
        todo = failed
    return results
