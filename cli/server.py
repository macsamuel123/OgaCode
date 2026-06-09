import json
import os
import re
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
EXPENSES_FILE = os.path.join(BASE_DIR, "expenses.json")

CATEGORIES = ["Food", "Transport", "Data", "Electricity", "Entertainment", "Other"]


def load_expenses():
    if not os.path.exists(EXPENSES_FILE):
        return []
    with open(EXPENSES_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_expenses(expenses):
    with open(EXPENSES_FILE, "w", encoding="utf-8") as f:
        json.dump(expenses, f, indent=2)


def next_id(expenses):
    if not expenses:
        return 1
    return max(e["id"] for e in expenses) + 1


class ExpenseHandler(BaseHTTPRequestHandler):

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, content, status=200):
        body = content.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_static(self, path):
        file_path = os.path.join(BASE_DIR, path)
        if not os.path.isfile(file_path):
            self._send_json({"error": "Not Found"}, 404)
            return
        ext = os.path.splitext(file_path)[1].lower()
        mime_map = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css",
            ".js": "application/javascript",
            ".json": "application/json",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon",
        }
        mime = mime_map.get(ext, "application/octet-stream")
        with open(file_path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return b""
        return self.rfile.read(length)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/expenses":
            raw = self._read_body()
            try:
                data = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._send_json({"error": "Invalid JSON"}, 400)
                return
            description = str(data.get("description", "")).strip()
            amount_raw = data.get("amount")
            category = str(data.get("category", "")).strip()

            if not description:
                self._send_json({"error": "Description is required"}, 400)
                return
            try:
                amount = float(amount_raw)
                if amount <= 0:
                    raise ValueError
            except (ValueError, TypeError):
                self._send_json({"error": "Amount must be a positive number"}, 400)
                return
            if category not in CATEGORIES:
                self._send_json({"error": f"Category must be one of {CATEGORIES}"}, 400)
                return

            expenses = load_expenses()
            expense = {
                "id": next_id(expenses),
                "description": description,
                "amount": amount,
                "category": category,
            }
            expenses.append(expense)
            save_expenses(expenses)
            self._send_json(expense, 201)
            return

        self._send_json({"error": "Not Found"}, 404)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/expenses":
            expenses = load_expenses()
            self._send_json(expenses)
            return

        # Serve index.html for root
        if path == "/" or path == "":
            path = "/index.html"

        # Try to serve static file
        static_path = path.lstrip("/")
        file_path = os.path.join(BASE_DIR, static_path)
        if os.path.isfile(file_path):
            self._send_static(static_path)
            return

        self._send_json({"error": "Not Found"}, 404)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path

        m = re.match(r"^/api/expenses/(\d+)$", path)
        if not m:
            self._send_json({"error": "Not Found"}, 404)
            return

        expense_id = int(m.group(1))
        expenses = load_expenses()
        new_expenses = [e for e in expenses if e["id"] != expense_id]
        if len(new_expenses) == len(expenses):
            self._send_json({"error": "Not found"}, 404)
            return
        save_expenses(new_expenses)
        self._send_json({"result": "deleted"})

    def log_message(self, format, *args):
        pass  # suppress logs


def run_server(host="127.0.0.1", port=5500):
    server = HTTPServer((host, port), ExpenseHandler)
    print(f"Server running on http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    run_server()
