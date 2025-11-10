import psycopg2

db_host = "database-2.c9agu2es0igp.ap-southeast-2.rds.amazonaws.com"
db_name = "test_name"
db_user = "postgres"
db_pass = "progknowledge"

connection = psycopg2.connect(
    host=db_host,
    database=db_name,
    user=db_user,
    password=db_pass
)

print("Connection to the database was successful.")

cursor = connection.cursor()
cursor.execute("SELECT version();")
db_version = cursor.fetchone()
print(f"Database version: {db_version}")

cursor.close()