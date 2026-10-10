import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { MockRuntime } from '../server/runtime';

// A new JDK client sends an unknown-length POST using chunked encoding and
// attempts h2c upgrade. WireMock 3.13.2 cancels this stream if HTTP/2 is enabled.
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mockingbird-runtime-'));
const runtime=new MockRuntime(path.resolve('runtime/wiremock-standalone-3.13.2.jar'),path.join(temp,'wiremock'),()=>{});
try{
  const socket=net.createServer();
  await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=(socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve,reject)=>socket.close(error=>error?reject(error):resolve()));
  await runtime.start(port,[]);
  await runtime.admin('mappings','POST',{
    request:{method:'POST',url:'/orders',bodyPatterns:[{equalToJson:{sku:'sku_001',quantity:1}}]},
    response:{status:201,headers:{'Content-Type':'application/json'},jsonBody:{id:'order_001'}}
  });
  const source=path.join(temp,'ChunkedPost.java');
  await fs.writeFile(source,`import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
class ChunkedPost {
  public static void main(String[] args) throws Exception {
    byte[] body = "{\\\"sku\\\":\\\"sku_001\\\",\\\"quantity\\\":1}".getBytes(StandardCharsets.UTF_8);
    var request = HttpRequest.newBuilder(URI.create(args[0])).timeout(Duration.ofSeconds(10))
      .header("Content-Type", "application/json")
      .POST(HttpRequest.BodyPublishers.ofInputStream(() -> new ByteArrayInputStream(body))).build();
    var client = HttpClient.newBuilder().version(HttpClient.Version.HTTP_2).build();
      var response = client.send(request, HttpResponse.BodyHandlers.ofString());
      if (response.statusCode() != 201 || !response.body().contains("order_001"))
        throw new AssertionError(response.statusCode() + " " + response.body());
      if (response.version() != HttpClient.Version.HTTP_1_1)
        throw new AssertionError("Expected HTTP/1.1 fallback: " + response.version());
      System.out.println("Chunked POST /orders: HTTP/1.1 201, expected mock body");
  }
}
`);
  const {stdout}=await promisify(execFile)(process.env.JAVA_PATH||'java',[source,`http://127.0.0.1:${port}/orders`],{timeout:30000});
  console.log(stdout.trim());
  const requests=await runtime.requests();
  assert(requests.some(request=>request.url==='/orders'&&request.matched&&request.status===201));
}finally{
  await runtime.stop();
  await fs.rm(temp,{recursive:true,force:true});
}
