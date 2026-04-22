from py.models import User
from py.utils import greet
import json

def main():
    u = User("alice")
    greet(u)
    return json.dumps({"ok": True})
