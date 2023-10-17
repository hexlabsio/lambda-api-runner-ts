#!/usr/bin/env ts-node

import {Command} from "commander";
import * as tsNode from "ts-node";
import cors from "cors";
import chalk from "chalk";
import {PathInfo} from "@hexlabs/schema-api-ts/dist/mapper";
import express, {RequestHandler} from "express";
import {APIGatewayProxyEvent} from "aws-lambda";
import {Request} from "express-serve-static-core";

import 'dotenv/config'

const program = new Command();

type Paths = Record<string, PathInfo>
type ApiDefinition = {
    path: string,
    methods: string[]
}

function apiDefinitionFromPaths(paths: Paths, parent = ''): ApiDefinition[] {
    const resources = Object.keys(paths);
    return resources.flatMap(resource => apiDefinitionFromPathInfo(paths[resource], parent + resource));
}

function apiDefinitionFromPathInfo(path: PathInfo, parent: string): ApiDefinition[] {
    const thisLevel = (path.methods?.length ?? 0) > 0 ? [{path: parent.replace(/{([^/{}]+)}/g, ":$1"), methods: path.methods!}] : [];
    const children = path.paths ? apiDefinitionFromPaths(path.paths, parent) : [];
    return [...thisLevel, ...children];
}

function rawBody(req: any, res: any, next: any) {
    req.setEncoding("utf8");
    req.rawBody = "";
    req.on("data", function (chunk: any) {
        req.rawBody += chunk;
    });
    req.on("end", function () {
        next();
    });
}

function queryParameters(expressQuery: {
    [key: string]: undefined | string | string[];
}) {
    return Object.keys(expressQuery).reduce(
        (acc, elem) => {
            if (expressQuery[elem]) {
                return Array.isArray(expressQuery[elem])
                    ? {
                        queryStringParameters: {
                            ...acc.queryStringParameters,
                            [elem]: (expressQuery[elem] as string[])[0],
                        },
                        multiValueQueryStringParameters: {
                            ...acc.multiValueQueryStringParameters,
                            [elem]: expressQuery[elem],
                        },
                    }
                    : {
                        queryStringParameters: {
                            ...acc.queryStringParameters,
                            [elem]: expressQuery[elem],
                        },
                        multiValueQueryStringParameters: {
                            ...acc.multiValueQueryStringParameters,
                            [elem]: [expressQuery[elem]],
                        },
                    };
            } else {
                return acc;
            }
        },
        {
            queryStringParameters: {},
            multiValueQueryStringParameters: {},
        }
    );
}

function extractCognitoRequestContext(req: Request): { authorizer: { claims: unknown } } | undefined {
    const authHeader = req.header("Authorization");
    const claims =
        authHeader && authHeader.includes("Bearer ")
            ? Buffer.from(authHeader.substring(7).split(".")[1], "base64").toString(
                "ascii"
            )
            : undefined;
    return claims
        ? { authorizer: { claims: JSON.parse(claims) } }
        : undefined;
}

function functionFor(
    method: string,
    path: string,
    codeLocation: string,
    handler: string,
    useCognitoClaims: boolean
): RequestHandler {
    return async (req, res) => {
        const headers = req.headers;
        const requestContext = useCognitoClaims ? {requestContext: extractCognitoRequestContext(req)} : {};
        const params = req.params;
        const queryParams = queryParameters(
            (req.query ?? {}) as { [key: string]: undefined | string | string[] }
        );
        const event: APIGatewayProxyEvent = {
            headers: headers as APIGatewayProxyEvent["headers"],
            resource: path,
            body: (req as any).rawBody,
            httpMethod: method.toUpperCase(),
            pathParameters: params,
            path: req.path,
            ...requestContext,
            ...queryParams,
        } as unknown as APIGatewayProxyEvent;
        const code = await import(`${codeLocation}?update=${Date.now()}`);
        code[handler](event)
            .then((response: any) => {
                console.log(
                    chalk.green(
                        "API - " +
                        method +
                        " " +
                        req.path +
                        " responded with " +
                        response.statusCode
                    )
                );
                res
                    .status(response.statusCode)
                    .set(response.headers)
                    .send(response.body);
            })
            .catch((error: any) => {
                console.log(
                    chalk.red("API - " + method + " " + req.path + " threw " + error)
                );
                console.error(chalk.red(error?.stack));
                res.status(500).send(error.message);
            });
    };
}

function attachApis(
    apis: ApiDefinition[],
    handler: string,
    codeLocation: string,
    port: string,
    app: any,
    useCognitoClaims: boolean
) {
    apis.forEach((resource) => {
        resource.methods.forEach(method => {
            app[method.toLowerCase()](
                resource.path,
                functionFor(method, resource.path.replace(/:([^/{}]+)/g, "{$1}"), codeLocation, handler, useCognitoClaims)
            );
            console.log(
                chalk.green(`${method} http://localhost:${port}${resource.path}`)
            );
        });
    });
}

async function setEnvironments(location: string) {
    console.log(chalk.green('Loading environment variables from json file at ', location))
    const envJson = await import(`${location}?update=${Date.now()}`);
    Object.keys(envJson).forEach(key => {
        const value = envJson[key];
        console.log(chalk.green(`Setting Environment - ${key} = ${value}`));
        process.env[key] = value;
    })
}

async function runApi(
    apiInfo: string,
    handler: string,
    entryPoint: string,
    command: any
) {
    try {
        if (command.tsProject) {
            console.log(chalk.green("Registering tsConfig", command.tsProject))
            tsNode.register({ project: command.tsProject });
        } else {
            tsNode.register({ typeCheck: false });
        }
        if(command.environmentVariables) {
            await setEnvironments(command.environmentVariables)
        }
        console.log(
            chalk.green(`Running apis from definitions at ${apiInfo}`)
        );
        const paths = await import(apiInfo, {
            assert: { type: "json" },
        });
        const definitions = apiDefinitionFromPaths(paths.default);
        console.log(chalk.green('Loading entrypoint at ', entryPoint));
        const lambda = await import(`${entryPoint}?update=${Date.now()}`);
        if (lambda && lambda[handler]) {
            if (definitions.length === 0) {
                console.log(
                    chalk.red(
                        "No API definitions exported please check docs on usage"
                    )
                );
                process.exit(1);
            }
            const PORT = process.env.PORT || "3000";
            const app = express();
            app.use(rawBody);
            app.use(cors())
            attachApis(definitions, handler, entryPoint, PORT, app, command.cognitoClaims);
            app.listen(PORT, () =>
                console.log(`Api is running here 👉 http://localhost:${PORT}`)
            );
        } else {
            throw new Error("Handler not found in code file");
        }
    } catch (e) {
        console.log(chalk.red('The following error occurred'))
        console.error(e);
        process.exit(1);
    }
}

function startCommand(): any {
    return program
        .command("start <apiInfo> <handler> <entrypoint>")
        .option(
            "-e, --environment-variables <envVarsLocation>",
            "Location of Local Environment Variables"
        )
        .option("-t, --ts-project <fileName>", "TS Config")
        .option("-c, --cognito-claims", "Extract Claims into request context like cognito would")
        .action(runApi);
}

(async () => {
    try {
        startCommand();
        await program.parseAsync(process.argv);
    } catch (e) {
        process.exit(1);
    }
})();