import path from 'path';
import fs from 'fs';
import parser from '@babel/parser';
import _traverse from '@babel/traverse';
import t from '@babel/types';
import doclyConfig from './doclyConfig.json';

const traverse = _traverse.default;
const httpMethods = ['get', 'post', 'put', 'patch', 'delete'];

function getAllFiles(absolutePath: string): Array<string> {
	const files: Array<string> = [];
	fs.readdirSync(absolutePath, { encoding: 'utf-8', recursive: true }).forEach(
		(item) => {
			const itemPath: string = path.join(absolutePath, item);
			if (doclyConfig.excluded?.some((ex: string) => item.includes(ex))) return;
			if (fs.lstatSync(itemPath).isDirectory()) return;
			if (/\.(js|ts)$/.test(item)) files.push(itemPath);
		}
	);
	return files;
}

function parseToAST(code: string): any {
	return parser.parse(code, {
		sourceType: 'unambiguous',
		plugins: ['jsx', 'typescript', 'dynamicImport'],
		errorRecovery: true,
	});
}

function tryResolveImport(baseFile: string, importPath: string): string | null {
	if (!importPath.startsWith('.')) return null;
	const baseDir = path.dirname(baseFile);
	const raw = path.resolve(baseDir, importPath);
	const tryList = ['.ts', '.js', '/index.ts', '/index.js'];
	for (const suff of tryList) {
		if (fs.existsSync(raw + suff)) return raw + suff;
	}
	if (fs.existsSync(raw)) return raw;
	return null;
}

function isDotEnv(node: any): boolean {
	return (
		t.isMemberExpression(node) &&
		t.isMemberExpression(node.object) &&
		t.isIdentifier(node.object.object, { name: 'process' }) &&
		t.isIdentifier(node.object.property, { name: 'env' })
	);
}

function extractAll(ast: object, absolutePath: string, currentFile: string) {
	const routes: any[] = [];
	const routers: Set<string> = new Set();
	const apps: Set<string> = new Set();
	const apiDetails: any = {};
	const routerPrefix: any = {};
	const imports: any = {};
	const variables: any[] = [];
	const middlewares: { global: any[]; local: any; declared: any } = {
		global: [],
		local: {},
		declared: {},
	};

	traverse(ast, {
		VariableDeclaration: ({ node }) => {
			const decl: any = node.declarations[0];
			if (!decl) return;

			let value: any = null;
			let isEnv = false;

			// ENV: const port = process.env.PORT || 3000
			if (
				t.isLogicalExpression(decl.init) &&
				(isDotEnv(decl.init.left) || isDotEnv(decl.init.right))
			) {
				isEnv = true;
				value = isDotEnv(decl.init.left)
					? decl.init.right.value
					: decl.init.left.value;
			}

			// Normal literal
			if (t.isLiteral(decl.init)) value = decl.init.value;

			variables.push({ name: decl.id.name, value, isEnv });

			// express app
			if (
				t.isIdentifier(decl.id) &&
				t.isCallExpression(decl.init) &&
				t.isIdentifier(decl.init.callee) &&
				decl.init.callee.name === 'express'
			) {
				apps.add(decl.id.name);
			}

			// express.Router()
			if (
				t.isIdentifier(decl.id) &&
				t.isCallExpression(decl.init) &&
				t.isMemberExpression(decl.init.callee) &&
				t.isIdentifier(decl.init.callee.object) &&
				decl.init.callee.object.name === 'express' &&
				t.isIdentifier(decl.init.callee.property) &&
				decl.init.callee.property.name === 'Router'
			) {
				routers.add(decl.id.name);
			}
		},

		ImportDeclaration: ({ node }) => {
			const alias = node.specifiers?.[0]?.local?.name;
			const src = node.source?.value;
			if (!alias || !src) return;
			const resolved = tryResolveImport(currentFile, src);
			if (resolved) imports[alias] = resolved;
		},

		ExpressionStatement: ({ node }) => {
			const expression: any = node.expression;
			if (
				!t.isCallExpression(expression) ||
				!t.isMemberExpression(expression.callee)
			)
				return;
			const obj: any = expression.callee.object;
			const prop: any = expression.callee.property;
			const args: any[] = expression.arguments || [];

			// app.use(...)
			if (t.isIdentifier(obj) && apps.has(obj.name) && prop.name === 'use') {
				if (args.length === 1) {
					if (t.isCallExpression(args[0]) && t.isIdentifier(args[0].callee)) {
						middlewares.global.push({ name: args[0].callee.name });
					}
					if (t.isArrowFunctionExpression(args[0])) {
						middlewares.global.push({ name: 'Anonymous Middleware' });
					}
				}
				if (args.length === 2) {
					if (
						t.isStringLiteral(args[0]) &&
						t.isCallExpression(args[1]) &&
						t.isIdentifier(args[1].callee)
					) {
						const mwName = args[1].callee.name;
						if (!middlewares.local[mwName]) middlewares.local[mwName] = [];
						middlewares.local[mwName].push({ path: args[0].value });
					}
				}
			}

			// app.listen(...)
			if (t.isIdentifier(obj) && apps.has(obj.name) && prop.name === 'listen') {
				const [portArg, hostArg, backlogArg] = args;
				function resolveVal(arg: any) {
					if (!arg) return null;
					if (t.isLiteral(arg)) return arg.value;
					if (t.isIdentifier(arg)) {
						const v = variables.find((v) => v.name === arg.name);
						return v ? v.value : null;
					}
					return null;
				}
				const portVar = variables.find((v) => v.name === portArg?.name);
				apiDetails.portNumber = resolveVal(portArg);
				apiDetails.isPortEnv = portVar?.isEnv || false;
				apiDetails.host = resolveVal(hostArg);
				apiDetails.backlog = resolveVal(backlogArg);
			}

			// app.get/post/...
			if (
				t.isIdentifier(obj) &&
				apps.has(obj.name) &&
				httpMethods.includes(prop.name)
			) {
				const first = args[0];
				const method = prop.name;
				const middlewareList: string[] = [];

				if (args.length > 2) {
					for (let i = 1; i < args.length - 1; i++) {
						if (t.isIdentifier(args[i])) middlewareList.push(args[i].name);
					}
				}

				if (t.isStringLiteral(first)) {
					let desc = null;
					if ((node as any).leadingComments) {
						const c = (node as any).leadingComments.find((x: any) =>
							x.value.includes('--Docly--')
						);
						if (c) desc = c.value.replace('--Docly--', '').trim();
					}
					routes.push({
						path: first.value,
						method,
						router: null,
						sourceFile: currentFile,
						middleware: middlewareList,
						description: desc,
					});
				}
			}

			// router.get/post/...
			if (
				t.isIdentifier(obj) &&
				routers.has(obj.name) &&
				httpMethods.includes(prop.name)
			) {
				const first = args[0];
				const method = prop.name;
				const middlewareList: string[] = [];

				if (args.length > 2) {
					for (let i = 1; i < args.length - 1; i++) {
						if (t.isIdentifier(args[i])) middlewareList.push(args[i].name);
					}
				}

				if (t.isStringLiteral(first)) {
					let desc = null;
					if ((node as any).leadingComments) {
						const c = (node as any).leadingComments.find((x: any) =>
							x.value.includes('--Docly--')
						);
						if (c) desc = c.value.replace('--Docly--', '').trim();
					}
					routes.push({
						path: first.value,
						method,
						router: obj.name,
						sourceFile: currentFile,
						middleware: middlewareList,
						description: desc,
					});
				}
			}
		},
	});

	return {
		file: currentFile,
		imports,
		routerPrefix,
		apiDetails,
		routes,
		middlewares,
	};
}

function applyRoutePrefixes(data: any) {
	const { apiDetails, routes, prefixByRouteFile } = data;
	const updated: any[] = [];
	routes.forEach((r: any) => {
		const mount = prefixByRouteFile[r.sourceFile];
		if (mount) {
			if (Array.isArray(mount)) {
				mount.forEach((p: string) => {
					updated.push({ ...r, path: pathJoin(p, r.path) });
				});
			} else {
				updated.push({ ...r, path: pathJoin(mount, r.path) });
			}
		} else {
			updated.push(r);
		}
	});
	return { apiDetails, routes: updated };
}

function pathJoin(prefix: string, routePath: string) {
	const cleanPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
	const cleanPath = routePath.startsWith('/') ? routePath : `/${routePath}`;
	return cleanPrefix + cleanPath;
}

function generateHTML(doc: any) {
	const grouped: any = {};
	doc.routes.forEach((r: any) => {
		const method = r.method.toUpperCase();
		if (!grouped[method]) grouped[method] = [];
		grouped[method].push(r);
	});

	const methodKeys = Object.keys(grouped);
	const multiColumn = methodKeys.length > 2;

	let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>API Docs</title>
  <style>
  body{font-family:Segoe UI, Arial, sans-serif; background:#eef1f7; padding:30px; color:#333;}
  h1{color:#2c3e50; text-align:center; margin-bottom:40px;}
  .server-row{display:flex;justify-content:center;gap:30px;margin-bottom:20px;flex-wrap:wrap;}
  .server-box{background:#fff;padding:15px 25px;border-radius:10px;box-shadow:0 2px 6px rgba(0,0,0,0.1);}
  .columns{${
		multiColumn
			? 'display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;'
			: 'display:block;'
	}}
  .column{flex:1;min-width:250px;margin-bottom:20px;}
  .column h2{text-align:center;background:#37353E;color:#fff;padding:10px;border-radius:8px;}
  .endpoint{background:#fff;margin:15px 0;padding:15px;border-radius:10px;box-shadow:0 2px 6px rgba(0,0,0,0.1);}
  .endpoint h3{margin:0;font-size:16px;}
  .method{font-weight:bold;padding:3px 6px;border-radius:4px;color:#fff;}
  .GET{background:#2ecc71;}
  .POST{background:#3498db;}
  .PUT{background:#f39c12;}
  .PATCH{background:#9b59b6;}
  .DELETE{background:#e74c3c;}
  .path{font-family:monospace;margin-left:8px;color:#555;}
  .desc{margin:8px 0;}
  .tag{display:inline-block;padding:3px 6px;font-size:12px;border-radius:5px;background:#ecf0f1;margin:2px;}
  </style>
  </head><body>`;
	html += `<h1>API Documentation</h1>`;
	if (doc.apiDetails) {
		html += `<div class="server-row">`;
		if (doc.apiDetails.portNumber)
			html += `<div class="server-box"><b>Port:</b> ${
				doc.apiDetails.portNumber
			} ${doc.apiDetails.isPortEnv ? '(env)' : ''}</div>`;
		if (doc.apiDetails.host)
			html += `<div class="server-box"><b>Host:</b> ${doc.apiDetails.host}</div>`;
		if (doc.apiDetails.backlog)
			html += `<div class="server-box"><b>Backlog:</b> ${doc.apiDetails.backlog}</div>`;
		if (doc.middlewares?.global?.length) {
			html += `<div class="server-box"><b>Global Middleware:</b> `;
			doc.middlewares.global.forEach((mw: any) => {
				html += `<span class="tag">${mw.name}</span>`;
			});
			html += `</div>`;
		}
		html += `</div>`;
	}
	html += `<div class="columns">`;
	methodKeys.forEach((method) => {
		html += `<div class="column"><h2>${method}</h2>`;
		grouped[method].forEach((r: any) => {
			html += `<div class="endpoint">`;
			html += `<h3><span class="method ${method}">${method}</span><span class="path">${r.path}</span></h3>`;
			if (r.description) html += `<p class="desc">${r.description}</p>`;
			if (r.middleware?.length) {
				html += `<div><b>Middleware:</b> `;
				r.middleware.forEach((m: string) => {
					html += `<span class="tag">${m}</span>`;
				});
				html += `</div>`;
			}
			html += `</div>`;
		});
		html += `</div>`;
	});
	html += `</div>`;
	html += `</body></html>`;
	fs.writeFileSync('apidoc.html', html);
}

function main() {
	const apiFolder = process.argv[2];
	if (!apiFolder) {
		console.error('Usage: tsx index.ts <src-folder>');
		process.exit(1);
	}
	const absolutePath = path.resolve(apiFolder);
	if (!fs.existsSync(absolutePath)) {
		console.error('Folder not found: ' + absolutePath);
		process.exit(1);
	}

	const files = getAllFiles(absolutePath);
	const extracts: any[] = [];
	files.forEach((file) => {
		const code = fs.readFileSync(file, 'utf8');
		const ast = parseToAST(code);
		extracts.push(extractAll(ast, absolutePath, file));
	});

	const apiDetails: any = {};
	const middlewares: any = { global: [], local: {} };

	extracts.forEach((ex) => {
		Object.assign(apiDetails, ex.apiDetails);
		if (ex.middlewares?.global?.length)
			middlewares.global.push(...ex.middlewares.global);
		if (ex.middlewares?.local)
			Object.assign(middlewares.local, ex.middlewares.local);
	});

	const prefixByRouteFile: any = {};
	extracts.forEach((ex) => {
		for (const [alias, mount] of Object.entries(ex.routerPrefix)) {
			const targetFile = ex.imports[alias];
			if (targetFile) {
				prefixByRouteFile[targetFile] = mount;
			}
		}
	});

	const allRoutes = extracts.flatMap((e) => e.routes);
	const finalOutput = applyRoutePrefixes({
		apiDetails,
		routes: allRoutes,
		prefixByRouteFile,
	});
	finalOutput.middlewares = middlewares;

	fs.writeFileSync('output.json', JSON.stringify(finalOutput, null, 2));
	generateHTML(finalOutput);
}

main();
