const path = require('path');
var webpack = require('webpack');
var nodeExternals = require('webpack-node-externals');

module.exports = {
    mode: 'production',
    entry: path.join(__dirname, 'src', 'index.js'), //'./src/index.js',
    output: {
        path: path.join(__dirname),
        filename: 'index.js',
        libraryTarget: 'this'
    },
    target: 'node',
    module: {
        rules: [
            { test: /\.js$/, exclude: /node_modules/, loader: "babel-loader" }
        ]
    },
    externals: [nodeExternals()]
}