// Rpc.define returns this portable object unchanged; no SDK dependency is needed.
const input={type:'object',properties:{sessionID:{type:'string',minLength:1,maxLength:200}},required:['sessionID'],additionalProperties:false};
export const Usage={id:'opencode-kit.usage',methods:{
 snapshot:{input,output:{type:'object',additionalProperties:true}},
 reset:{input,output:{type:'object',properties:{reset:{type:'boolean'}},required:['reset'],additionalProperties:false}},
},events:{}};
