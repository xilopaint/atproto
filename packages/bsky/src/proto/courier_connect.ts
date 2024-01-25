// @generated by protoc-gen-connect-es v1.3.0 with parameter "target=ts,import_extension=.ts"
// @generated from file courier.proto (package courier, syntax proto3)
/* eslint-disable */
// @ts-nocheck

import { PingRequest, PingResponse, PushNotificationsRequest, PushNotificationsResponse, RegisterDeviceTokenRequest, RegisterDeviceTokenResponse } from "./courier_pb.ts";
import { MethodKind } from "@bufbuild/protobuf";

/**
 * @generated from service courier.Service
 */
export const Service = {
  typeName: "courier.Service",
  methods: {
    /**
     * @generated from rpc courier.Service.Ping
     */
    ping: {
      name: "Ping",
      I: PingRequest,
      O: PingResponse,
      kind: MethodKind.Unary,
    },
    /**
     * @generated from rpc courier.Service.PushNotifications
     */
    pushNotifications: {
      name: "PushNotifications",
      I: PushNotificationsRequest,
      O: PushNotificationsResponse,
      kind: MethodKind.Unary,
    },
    /**
     * @generated from rpc courier.Service.RegisterDeviceToken
     */
    registerDeviceToken: {
      name: "RegisterDeviceToken",
      I: RegisterDeviceTokenRequest,
      O: RegisterDeviceTokenResponse,
      kind: MethodKind.Unary,
    },
  }
} as const;

