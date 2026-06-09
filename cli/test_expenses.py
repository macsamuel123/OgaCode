import threading
import time
import json
import urllib.request
import urllib.error
import os
import sys

sys.path.insert(0, r"C:\Users\User\OgaCode\cli")

# Clean up any existing expenses.json
exp_file = r"C:\Users\User\OgaCode\cli\expenses.json"
if os.path.exists(exp_file):
    os.remove(exp_file)

# Import and start server in background thread
from server import run_server

srv_thread = threading.Thread(target=run_server, args=("127.0.0.1", 5500), daemon=True)
srv_thread.start()
time.sleep(1)

base = "http://127.0.0.1:5500"

# Test 1: GET /api/expenses (empty)
req = urllib.request.Request(base + "/api/expenses")
res = urllib.request.urlopen(req)
data = json.loads(res.read())
assert data == [], f"Expected empty list, got {data}"
print("PASS: GET empty list")

# Test 2: POST /api/expenses
payload = json.dumps({"description": "Danfo bus to work", "amount": 500, "category": "Transport"}).encode()
req = urllib.request.Request(base + "/api/expenses", data=payload, headers={"Content-Type": "application/json"}, method="POST")
res = urllib.request.urlopen(req)
data = json.loads(res.read())
assert data["description"] == "Danfo bus to work"
assert data["amount"] == 500
assert data["category"] == "Transport"
assert "id" in data
eid = data["id"]
print(f"PASS: POST expense (id={eid})")

# Test 3: POST another expense
payload2 = json.dumps({"description": "Jollof rice", "amount": 3500, "category": "Food"}).encode()
req2 = urllib.request.Request(base + "/api/expenses", data=payload2, headers={"Content-Type": "application/json"}, method="POST")
res2 = urllib.request.urlopen(req2)
data2 = json.loads(res2.read())
print(f'PASS: POST second expense (id={data2["id"]})')

# Test 4: GET /api/expenses (should have 2)
req3 = urllib.request.Request(base + "/api/expenses")
res3 = urllib.request.urlopen(req3)
data3 = json.loads(res3.read())
assert len(data3) == 2, f"Expected 2 expenses, got {len(data3)}"
print("PASS: GET list has 2 expenses")

# Test 5: DELETE /api/expenses/{id}
req4 = urllib.request.Request(base + f"/api/expenses/{eid}", method="DELETE")
res4 = urllib.request.urlopen(req4)
data4 = json.loads(res4.read())
assert data4["result"] == "deleted"
print("PASS: DELETE expense")

# Test 6: GET after delete (should have 1)
req5 = urllib.request.Request(base + "/api/expenses")
res5 = urllib.request.urlopen(req5)
data5 = json.loads(res5.read())
assert len(data5) == 1, f"Expected 1 expense, got {len(data5)}"
print("PASS: GET after delete has 1 expense")

# Test 7: GET / (index.html)
req6 = urllib.request.Request(base + "/")
res6 = urllib.request.urlopen(req6)
html = res6.read().decode()
assert "<title>Nigerian Expense Tracker</title>" in html
print("PASS: GET / serves index.html")

# Test 8: Validation - missing description
payload_bad = json.dumps({"amount": 500, "category": "Food"}).encode()
req7 = urllib.request.Request(base + "/api/expenses", data=payload_bad, headers={"Content-Type": "application/json"}, method="POST")
try:
    urllib.request.urlopen(req7)
    print("FAIL: should have rejected missing description")
except urllib.error.HTTPError as e:
    assert e.code == 400
    print("PASS: validation - missing description rejected")

# Test 9: Validation - bad category
payload_bad2 = json.dumps({"description": "test", "amount": 500, "category": "Shopping"}).encode()
req8 = urllib.request.Request(base + "/api/expenses", data=payload_bad2, headers={"Content-Type": "application/json"}, method="POST")
try:
    urllib.request.urlopen(req8)
    print("FAIL: should have rejected bad category")
except urllib.error.HTTPError as e:
    assert e.code == 400
    print("PASS: validation - bad category rejected")

# Test 10: DELETE non-existent
req9 = urllib.request.Request(base + "/api/expenses/9999", method="DELETE")
try:
    urllib.request.urlopen(req9)
    print("FAIL: should have returned 404")
except urllib.error.HTTPError as e:
    assert e.code == 404
    print("PASS: DELETE non-existent returns 404")

print()
print("ALL TESTS PASSED")
