import os, sys
os.environ["PLANNER_SEED"] = "example"  # tests never depend on personal data
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import pytest
from app import create_app


@pytest.fixture
def app(tmp_path):
    os.environ.pop("APP_PASSWORD", None)
    return create_app({"SQLALCHEMY_DATABASE_URI": f"sqlite:///{tmp_path}/t.db", "TESTING": True})


@pytest.fixture
def client(app):
    return app.test_client()
