export async function handler (event: any): Promise<any> {
    console.log(event);
    return { statusCode: 200, body: 'Hello World' }
}