import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:8000"
TASKS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tasks.json")

def reset_tasks():
    if os.path.exists(TASKS_FILE):
        os.remove(TASKS_FILE)

def request(method, path, body=None):
    url = BASE + path
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))
    except Exception as e:
        return 0, {"error": str(e)}

def test_create():
    reset_tasks()
    status, data = request("POST", "/tasks", {"title": "Buy milk"})
    if status != 201:
        return f"FAIL: POST /tasks expected 201 got {status}"
    if data.get("title") != "Buy milk":
        return f"FAIL: POST /tasks title mismatch: {data}"
    if "id" not in data:
        return "FAIL: POST /tasks missing id"
    print(f"  PASS: POST /tasks -> {data}")
    return None

def test_list():
    reset_tasks()
    # Create two tasks first
    request("POST", "/tasks", {"title": "Task A"})
    request("POST", "/tasks", {"title": "Task B"})
    status, data = request("GET", "/tasks")
    if status != 200:
        return f"FAIL: GET /tasks expected 200 got {status}"
    if not isinstance(data, list):
        return f"FAIL: GET /tasks expected list got {type(data)}"
    if len(data) != 2:
        return f"FAIL: GET /tasks expected 2 tasks got {len(data)}"
    print(f"  PASS: GET /tasks -> {len(data)} tasks")
    return None

def test_get_one():
    reset_tasks()
    _, created = request("POST", "/tasks", {"title": "Unique task"})
    tid = created["id"]
    status, data = request("GET", f"/tasks/{tid}")
    if status != 200:
        return f"FAIL: GET /tasks/{tid} expected 200 got {status}"
    if data["title"] != "Unique task":
        return f"FAIL: GET /tasks/{tid} title mismatch"
    print(f"  PASS: GET /tasks/{tid} -> {data}")
    return None

def test_get_one_not_found():
    reset_tasks()
    status, data = request("GET", "/tasks/999")
    if status != 404:
        return f"FAIL: GET /tasks/999 expected 404 got {status}"
    print(f"  PASS: GET /tasks/999 -> 404")
    return None

def test_delete():
    reset_tasks()
    _, created = request("POST", "/tasks", {"title": "Delete me"})
    tid = created["id"]
    status, data = request("DELETE", f"/tasks/{tid}")
    if status != 200:
        return f"FAIL: DELETE /tasks/{tid} expected 200 got {status}"
    # Verify it's gone
    status2, _ = request("GET", f"/tasks/{tid}")
    if status2 != 404:
        return f"FAIL: DELETE /tasks/{tid} item still exists"
    print(f"  PASS: DELETE /tasks/{tid} -> deleted")
    return None

def test_delete_not_found():
    reset_tasks()
    status, data = request("DELETE", "/tasks/999")
    if status != 404:
        return f"FAIL: DELETE /tasks/999 expected 404 got {status}"
    print(f"  PASS: DELETE /tasks/999 -> 404")
    return None

def test_create_no_title():
    reset_tasks()
    status, data = request("POST", "/tasks", {})
    if status != 400:
        return f"FAIL: POST /tasks (no title) expected 400 got {status}"
    print(f"  PASS: POST /tasks (no title) -> 400")
    return None

def main():
    # Clean up any leftover tasks.json
    reset_tasks()

    # Start server in background
    server_proc = subprocess.Popen(
        [sys.executable, os.path.join(os.path.dirname(__file__), "server.py")],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(1)  # wait for server to start

    tests = [
        ("Create task", test_create),
        ("List tasks", test_list),
        ("Get one task", test_get_one),
        ("Get one not found", test_get_one_not_found),
        ("Delete task", test_delete),
        ("Delete not found", test_delete_not_found),
        ("Create no title", test_create_no_title),
    ]

    passed = 0
    failed = 0
    for name, fn in tests:
        print(f"Test: {name}")
        result = fn()
        if result is None:
            passed += 1
        else:
            print(f"  {result}")
            failed += 1

    server_proc.terminate()
    server_proc.wait()
    reset_tasks()

    print(f"\n{'='*30}")
    print(f"Results: {passed} PASS, {failed} FAIL")
    if failed == 0:
        print("ALL TESTS PASSED!")
    else:
        print("SOME TESTS FAILED!")
        sys.exit(1)

if __name__ == "__main__":
    main()
