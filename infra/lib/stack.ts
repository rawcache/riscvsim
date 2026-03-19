import * as fs from "node:fs";
import * as path from "node:path";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_apigatewayv2 as apigatewayv2,
  aws_apigatewayv2_authorizers as apigatewayv2Authorizers,
  aws_apigatewayv2_integrations as apigatewayv2Integrations,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_lambda as lambda,
} from "aws-cdk-lib";
import { Construct } from "constructs";

const DOMAIN_PREFIX = "studyriscv";
const CALLBACK_URLS = ["http://localhost:5173", "http://localhost:5174", "https://studyriscv.com"];
const LOGOUT_URLS = ["http://localhost:5173", "http://localhost:5174", "https://studyriscv.com"];

function inlineLambdaSource(fileName: string): string {
  return fs.readFileSync(path.join(__dirname, "..", "lambda", fileName), "utf8");
}

export class StudyRiscvStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const preSignupFn = new lambda.Function(this, "PreSignupFunction", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(inlineLambdaSource("pre-signup.ts")),
    });

    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "studyriscv-users",
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: false,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    userPool.addTrigger(cognito.UserPoolOperation.PRE_SIGN_UP, preSignupFn);

    const userPoolClient = new cognito.UserPoolClient(this, "UserPoolClient", {
      userPool,
      userPoolClientName: "studyriscv-web",
      generateSecret: false,
      authFlows: {
        userSrp: true,
        userPassword: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
        callbackUrls: CALLBACK_URLS,
        logoutUrls: LOGOUT_URLS,
      },
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    });

    userPool.addDomain("HostedUiDomain", {
      cognitoDomain: {
        domainPrefix: DOMAIN_PREFIX,
      },
    });

    const programsTable = new dynamodb.Table(this, "SavedProgramsTable", {
      tableName: "studyriscv-saved-programs",
      partitionKey: {
        name: "userId",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "programId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const programsFn = new lambda.Function(this, "ProgramsFunction", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(inlineLambdaSource("programs.ts")),
      environment: {
        PROGRAMS_TABLE_NAME: programsTable.tableName,
      },
    });

    programsTable.grantReadWriteData(programsFn);

    const httpApi = new apigatewayv2.HttpApi(this, "ProgramsApi", {
      apiName: "studyriscv-api",
      corsPreflight: {
        allowOrigins: CALLBACK_URLS,
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.DELETE,
        ],
        allowHeaders: ["Authorization", "Content-Type"],
      },
    });

    const issuer = `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`;
    const programsAuthorizer = new apigatewayv2Authorizers.HttpJwtAuthorizer(
      "ProgramsAuthorizer",
      issuer,
      {
        jwtAudience: [userPoolClient.userPoolClientId],
      }
    );

    const programsIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      "ProgramsIntegration",
      programsFn
    );

    httpApi.addRoutes({
      path: "/programs",
      methods: [
        apigatewayv2.HttpMethod.GET,
        apigatewayv2.HttpMethod.POST,
        apigatewayv2.HttpMethod.DELETE,
      ],
      integration: programsIntegration,
      authorizer: programsAuthorizer,
    });

    new CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
    });

    new CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });

    new CfnOutput(this, "CognitoHostedUiDomain", {
      value: `${DOMAIN_PREFIX}.auth.${this.region}.amazoncognito.com`,
    });

    new CfnOutput(this, "ApiEndpoint", {
      value: httpApi.apiEndpoint,
    });
  }
}
