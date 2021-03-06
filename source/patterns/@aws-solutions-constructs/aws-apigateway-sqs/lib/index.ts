/**
 *  Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

// Imports
import * as api from '@aws-cdk/aws-apigateway';
import * as sqs from '@aws-cdk/aws-sqs';
import * as iam from '@aws-cdk/aws-iam';
import * as defaults from '@aws-solutions-constructs/core';
import { Construct } from '@aws-cdk/core';
import * as cdk from '@aws-cdk/core';

/**
 * @summary The properties for the ApiGatewayToSqs class.
 */
export interface ApiGatewayToSqsProps {
    /**
     * Optional user-provided props to override the default props for the API Gateway.
     *
     * @default - Default properties are used.
     */
    readonly apiGatewayProps?: api.RestApiProps | any
    /**
     * Optional user-provided props to override the default props for the queue.
     *
     * @default - Default props are used
     */
    readonly queueProps?: sqs.QueueProps | any
    /**
     * Whether to deploy a secondary queue to be used as a dead letter queue.
     *
     * @default - required field.
     */
    readonly deployDeadLetterQueue?: boolean,
    /**
     * The number of times a message can be unsuccessfully dequeued before being moved to the dead-letter queue.
     *
     * @default - required only if deployDeadLetterQueue = true.
     */
    readonly maxReceiveCount?: number,
    /**
     * Whether to deploy an API Gateway Method for Create operations on the queue (i.e. sqs:SendMessage).
     *
     * @default - false
     */
    readonly allowCreateOperation?: boolean,
    /**
     * API Gateway Request template for Create method, required if allowCreateOperation set to true
     *
     * @default - None
     */
    readonly createRequestTemplate?: string,
    /**
     * Whether to deploy an API Gateway Method for Read operations on the queue (i.e. sqs:ReceiveMessage).
     *
     * @default - false
     */
    readonly allowReadOperation?: boolean,
    /**
     * Whether to deploy an API Gateway Method for Delete operations on the queue (i.e. sqs:DeleteMessage).
     *
     * @default - false
     */
    readonly allowDeleteOperation?: boolean
}

/**
 * @summary The ApiGatewayToSqs class.
 */
export class ApiGatewayToSqs extends Construct {
    public readonly apiGateway: api.RestApi;
    public readonly apiGatewayRole: iam.Role;
    public readonly sqsQueue: sqs.Queue;

    /**
     * @summary Constructs a new instance of the ApiGatewayToSqs class.
     * @param {cdk.App} scope - represents the scope for all the resources.
     * @param {string} id - this is a a scope-unique id.
     * @param {ApiGatewayToSqsProps} props - user provided props for the construct.
     * @since 0.8.0
     * @access public
     */
    constructor(scope: Construct, id: string, props: ApiGatewayToSqsProps) {
        super(scope, id);

        // Setup the dead letter queue, if applicable
        let dlqi: sqs.DeadLetterQueue | undefined;
        if (!props.deployDeadLetterQueue || props.deployDeadLetterQueue === true) {
            const dlq: sqs.Queue = defaults.buildQueue(this, 'deadLetterQueue', {
                queueProps: props.queueProps
            });
            dlqi = defaults.buildDeadLetterQueue({
                deadLetterQueue: dlq,
                maxReceiveCount: (props.maxReceiveCount) ? props.maxReceiveCount : 3
            });
        }

        // Setup the queue
        this.sqsQueue = defaults.buildQueue(this, 'queue', {
            queueProps: props.queueProps,
            deadLetterQueue: dlqi
        });

        // Setup the API Gateway
        this.apiGateway = defaults.GlobalRestApi(this);

        // Setup the API Gateway role
        this.apiGatewayRole = new iam.Role(this, 'api-gateway-role', {
            assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com')
        });

        // Setup the API Gateway resource
        const apiGatewayResource = this.apiGateway.root.addResource('message');

        // Setup API Gateway methods
        // Create
        if (props.allowCreateOperation && props.allowCreateOperation === true && props.createRequestTemplate) {
            const createRequestTemplate = "Action=SendMessage&MessageBody=$util.urlEncode(\"$input.body\")";
            this.addActionToPolicy("sqs:SendMessage");
            this.addMethod(this.apiGateway.root, createRequestTemplate, "POST");
        }
        // Read
        if (!props.allowReadOperation || props.allowReadOperation === true) {
            const getRequestTemplate = "Action=ReceiveMessage";
            this.addActionToPolicy("sqs:ReceiveMessage");
            this.addMethod(this.apiGateway.root, getRequestTemplate, "GET");
        }
        // Delete
        if (props.allowDeleteOperation && props.allowDeleteOperation === true) {
            const deleteRequestTemplate = "Action=DeleteMessage&ReceiptHandle=$util.urlEncode($input.params('receiptHandle'))";
            this.addActionToPolicy("sqs:DeleteMessage");
            this.addMethod(apiGatewayResource, deleteRequestTemplate, "DELETE");
        }
    }

    private addActionToPolicy(action: string) {
        this.apiGatewayRole.addToPolicy(new iam.PolicyStatement({
            resources: [
                this.sqsQueue.queueArn
            ],
            actions: [ `${action}` ]
        }));
    }

    private addMethod(apiResource: api.IResource, requestTemplate: string, apiMethod: string) {
        // Add the integration
        const apiGatewayIntegration = new api.AwsIntegration({
            service: "sqs",
            path: `${cdk.Aws.ACCOUNT_ID}/${this.sqsQueue.queueName}`,
            integrationHttpMethod: "POST",
            options: {
                passthroughBehavior: api.PassthroughBehavior.NEVER,
                credentialsRole: this.apiGatewayRole,
                requestParameters: {
                    "integration.request.header.Content-Type": "'application/x-www-form-urlencoded'"
                },
                requestTemplates: {
                    "application/json": requestTemplate
                },
                integrationResponses: [
                    {
                        statusCode: "200"
                    },
                    {
                        statusCode: "500",
                        responseTemplates: {
                            "text/html": "Error"
                        },
                        selectionPattern: "500"
                    }
                ]
            }
        });

        // Add the method to the resource
        apiResource.addMethod(apiMethod, apiGatewayIntegration, {
            authorizationType: api.AuthorizationType.IAM,
            methodResponses: [
                {
                    statusCode: "200",
                    responseParameters: {
                        "method.response.header.Content-Type": true
                    }
                },
                {
                    statusCode: "500",
                    responseParameters: {
                        "method.response.header.Content-Type": true
                    },
                }
            ]
        });
    }
}