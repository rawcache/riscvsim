#!/usr/bin/env bash
set -e

echo "Building backend..."
mvn clean package

echo "Starting server..."
java -jar target/riscvsim-backend-0.1.0.jar
