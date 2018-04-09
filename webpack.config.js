const fs = require('fs');
const path = require('path');
const webpack = require('webpack');
const ZipPlugin = require('zip-webpack-plugin');

module.exports = function (env) {
    const lambdaFunctionDir = path.join(__dirname, 'src', 'lambdas');
    const functionsToBuild = env && env.fxn ? env.fxn.split(",") : fs.readdirSync(lambdaFunctionDir).filter(item => fs.lstatSync(path.join(lambdaFunctionDir, item)).isDirectory() && !item.match(/^\./));
    console.log(`Building ${functionsToBuild.join(", ")}`);

    return functionsToBuild
        .map(fxn => ({
            context: path.resolve(__dirname),
            entry: path.join(lambdaFunctionDir, fxn, 'index.ts'),
            output: {
                path: path.join(__dirname, 'dist', fxn),
                filename: 'index.js',
                libraryTarget: 'commonjs2'
            },
            module: {
                rules: [
                    {
                        test: /\.js$/,
                        use: [
                            {
                                loader: 'babel-loader',
                                options: {
                                    presets: ['es2015'],
                                    plugins: ["transform-async-to-generator"],
                                    compact: false,
                                    babelrc: false
                                }
                            }
                        ]
                    },
                    {
                        test: /\.ts(x?)$/,
                        use: [
                            {
                                loader: 'babel-loader',
                                options: {
                                    presets: ['es2015'],
                                    plugins: ["transform-async-to-generator"],
                                    compact: false,
                                    babelrc: false
                                }
                            },
                            'ts-loader'
                        ]
                    },
                    {
                        test: /\.jpe?g$|\.gif$|\.png$|\.svg$|\.woff$|\.ttf$|\.wav$|\.mp3$/,
                        use: [
                            'file-loader'
                        ]
                    },
                    {
                        test: /\.sql$/,
                        use: [
                            'raw-loader'
                        ]
                    }
                ]
            },
            resolve: {
                extensions: ['.ts', '.tsx', '.js']
            },
            plugins: [
                new webpack.DefinePlugin({"global.GENTLY": false}), // see https://github.com/felixge/node-formidable/issues/337 for why
                new ZipPlugin({
                    path: path.join(__dirname, 'dist', fxn),
                    pathPrefix: '',
                    filename: `${fxn}.zip`
                })
            ],
            mode: 'development',
            target: 'node',
            externals: {
                // These modules are already installed on the Lambda instance.
                'aws-sdk': 'aws-sdk',
                'awslambda': 'awslambda',
                'dynamodb-doc': 'dynamodb-doc',
                'imagemagick': 'imagemagick',

                // Knex drivers we won't use.
                'sqlite3': 'sqlite3',
                'mariasql': 'mariasql',
                'mssql': 'mssql',
                'mysql': 'mysql',
                'oracle': 'oracle',
                'strong-oracle': 'strong-oracle',
                'oracledb': 'oracledb',
                'pg': 'pg',
                'pg-query-stream': 'pg-query-stream'
            },
            node: {
                // Allow these globals.
                __filename: false,
                __dirname: false
            },
            stats: 'errors-only',
            bail: true
        }));
};
