
# Docly - Legacy

<p align="center">
  <img src="https://github.com/iapheus/docly-legacy/blob/main/media/docly.gif" height="450"/>
</p>
<p align="center">
  <strong><em>We can detect everything!</em></strong>
</p>

Docly automatically generates simplified documentation for ExpressJS APIs using JavaScript AST (Abstract Syntax Tree).

## Screenshot of Output HTML Page

<p align="center">
  <img src="https://github.com/iapheus/docly-legacy/blob/main/media/htmlOutput.png" height="300"/>
</p>



## Features

- Detects the ```listen``` function in variables assigned with ```express()``` (like ```app```) and captures details such as ```port```, ```host```, and ```backlog```.
- Similarly, identifies HTTP methods and endpoints in variables assigned with ```router```.
- Finds all internal and external middleware and associates them with the relevant endpoints.
- Allows you to add descriptions to endpoints by including the ```--Docly--``` tag.
- Works with all coding styles (functions, arrow functions, inline middleware, etc.).

## Run Locally

Clone the project

```bash
  git clone https://github.com/iapheus/docly-legacy.git
```

Go to the project directory

```bash
  cd docly-legacy
```

Install dependencies

```bash
  npm install
```

Run the app

```bash
  tsx index.ts <folder>
```


# License
[GNU AGPLv3](https://choosealicense.com/licenses/agpl-3.0/)
