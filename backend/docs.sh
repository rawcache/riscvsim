#!/usr/bin/env bash
set -e

mvn clean javadoc:javadoc
open target/reports/apidocs/index.html