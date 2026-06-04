#!/bin/bash
set -e

echo "Installing frontend dependencies..."
cd frontend
npm ci
echo "Building frontend..."
npm run build
cd ..
echo "Frontend built to backend/static/"

echo "Installing backend dependencies..."
cd backend
pip install -r requirements.txt
cd ..
echo "Build complete."
