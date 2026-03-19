#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { StudyRiscvStack } from "../lib/stack";

const app = new cdk.App();

new StudyRiscvStack(app, "StudyRiscvStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "us-east-1",
  },
});
