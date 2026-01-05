#!/usr/bin/env bash
set -e

echo "BACKEND:"
cd backend
mvn clean package
java -jar target/riscvsim-backend-0.1.0.jar &
BACKEND_PID=$!

sleep 3

echo "FRONTEND:"
cd ../frontend
npm install
npm run dev &
FRONTEND_PID=$!

trap "kill $BACKEND_PID $FRONTEND_PID" EXIT
wait
